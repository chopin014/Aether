/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type SoundboardLibrary,
    type SoundboardSound,
    type SoundboardViewSnapshot,
    type SoundboardViewActions,
} from "@element-hq/web-shared-components";
import {
    type MatrixClient,
    MatrixEvent,
    type Room,
    RoomEvent,
    RoomStateEvent,
    MatrixEventEvent,
    EventStatus,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { SoundboardClip } from "../../audio/soundboard/SoundboardClip";
import { CallEvent, type ElementCall } from "../../models/Call";
import { _t } from "../../languageHandler";
import SettingsStore from "../../settings/SettingsStore";
import MediaDeviceHandler from "../../MediaDeviceHandler";
import type SpaceStore from "../../stores/spaces/SpaceStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { UPDATE_SELECTED_SPACE } from "../../stores/spaces";
import { mediaFromMxc } from "../../customisations/Media";
import {
    BUILTIN_SOUNDS,
    parseSound,
    SOUNDBOARD_EVENT,
    SOUNDBOARD_PLAY,
    SoundboardAudio,
    soundboardRooms,
    type StoredSound,
} from "../../audio/soundboard/Soundboard";

interface Props {
    client: MatrixClient;
    call: ElementCall;
    spaceStore?: SpaceStore;
}

/** Shared Matrix sound libraries and live playback for one connected call. */
export class SoundboardViewModel extends BaseViewModel<SoundboardViewSnapshot, Props> implements SoundboardViewActions {
    private static readonly shared = new WeakMap<ElementCall, { vm: SoundboardViewModel; owners: number }>();

    /** Retain one playback listener for both the dock and the in-call toolbar. */
    public static acquire(props: Props): { vm: SoundboardViewModel; release: () => void } {
        let entry = this.shared.get(props.call);
        if (!entry) {
            entry = { vm: new SoundboardViewModel(props), owners: 0 };
            this.shared.set(props.call, entry);
        }
        entry.owners++;
        let released = false;
        return {
            vm: entry.vm,
            release: () => {
                if (released) return;
                released = true;
                if (--entry.owners === 0) {
                    entry.vm.dispose();
                    this.shared.delete(props.call);
                }
            },
        };
    }

    private clip?: SoundboardClip;
    private editing?: { id: string; libraryId: string; original: StoredSound; replaced?: boolean };
    private editAbort?: AbortController;
    private readonly audio = new SoundboardAudio();
    private readonly spaceStore: SpaceStore;
    private readonly startedAt = Date.now();
    private readonly seen = new Set<string>();
    private readonly usage = new Map<string, number>();
    private readonly suggestedOrder = new Map<string, number>();
    private rooms: Room[] = [];
    private readonly pendingEncrypted = new Set<string>();
    private unsubscribeTransport?: () => void;

    public constructor(props: Props) {
        super(props, {
            query: "",
            libraries: [],
            suggested: [],
            volume: 80,
            busy: false,
            uploadLibraryId: "",
            uploadName: "",
            uploadEmoji: "🔊",
        });
        this.spaceStore = props.spaceStore ?? SDKContextClass.instance.spaceStore;
        this.disposables.track(() => this.audio.dispose());
        this.disposables.track(() => this.clip?.dispose());
        this.disposables.track(() => this.editAbort?.abort());
        this.disposables.track(() => this.unsubscribeTransport?.());
        this.disposables.trackListener(props.call, CallEvent.SoundboardTransport, this.bindTransport);
        this.bindTransport();
        props.client.on(RoomEvent.Timeline, this.onTimeline);
        props.client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
        this.disposables.track(() => props.client.off(RoomEvent.Timeline, this.onTimeline));
        this.disposables.track(() => props.client.off(MatrixEventEvent.Decrypted, this.onDecrypted));
        this.disposables.trackListener(props.client, RoomStateEvent.Events, this.refresh);
        this.disposables.trackListener(props.client, RoomEvent.Name, this.refresh);
        this.disposables.trackListener(this.spaceStore, UPDATE_SELECTED_SPACE, this.refresh);
        const watch = SettingsStore.watchSetting("desktopDeafened", null, () => {
            if (SettingsStore.getValue("desktopDeafened")) this.audio.stop();
            else this.refresh();
        });
        this.disposables.track(() => SettingsStore.unwatchSetting(watch));
        this.disposables.trackListener(props.call, CallEvent.ConnectionState, () => {
            if (!props.call.connected) this.audio.stop();
            else this.refresh();
        });
        this.refresh();
    }

    private readonly refresh = (): void => {
        if (this.isDisposed) return;
        const room = this.props.client.getRoom(this.props.call.roomId);
        this.rooms = room ? soundboardRooms(this.props.client, room) : [];
        const libraries: SoundboardLibrary[] = [
            ...[...this.rooms]
                .sort((a, b) => Number(b.isSpaceRoom()) - Number(a.isSpaceRoom()))
                .map((room) => {
                    const avatar = room.getMxcAvatarUrl();
                    return {
                        id: room.roomId,
                        name: room.name,
                        avatarUrl: avatar
                            ? (mediaFromMxc(avatar, this.props.client).getSquareThumbnailHttp(40) ?? undefined)
                            : undefined,
                        canUpload: room.currentState.maySendStateEvent(
                            SOUNDBOARD_EVENT,
                            this.props.client.getSafeUserId(),
                        ),
                        sounds: room.currentState.getStateEvents(SOUNDBOARD_EVENT).flatMap((event) => {
                            const sound = parseSound(event.getContent());
                            return sound
                                ? [
                                      {
                                          id: event.getStateKey()!,
                                          name: sound.name,
                                          emoji: sound.emoji,
                                          libraryId: room.roomId,
                                      },
                                  ]
                                : [];
                        }),
                    };
                }),
            {
                id: "builtin",
                name: _t("desktop|soundboard|aether_sounds"),
                canUpload: false,
                sounds: BUILTIN_SOUNDS.map((sound) => ({ ...sound, libraryId: "builtin" })),
            },
        ];
        const activeSpace = this.spaceStore.activeSpace;
        const priority = (library: SoundboardLibrary): number =>
            library.id === "builtin" ? 0 : library.id === activeSpace ? 1 : 2;
        libraries.sort((a, b) => priority(a) - priority(b));
        const all = libraries.flatMap((library) => library.sounds);
        const suggested = [...all]
            .sort(
                (a, b) =>
                    (this.suggestedOrder.get(`${a.libraryId}/${a.id}`) ?? Infinity) -
                        (this.suggestedOrder.get(`${b.libraryId}/${b.id}`) ?? Infinity) ||
                    (this.usage.get(`${b.libraryId}/${b.id}`) ?? 0) - (this.usage.get(`${a.libraryId}/${a.id}`) ?? 0),
            )
            .slice(0, 6);
        this.suggestedOrder.clear();
        suggested.forEach((sound, index) => this.suggestedOrder.set(`${sound.libraryId}/${sound.id}`, index));
        if (
            this.props.call.connected &&
            !this.props.call.locallyLeaving &&
            !SettingsStore.getValue("desktopDeafened")
        ) {
            const sources = [...suggested, ...all].flatMap((sound) => {
                const source = this.source(sound);
                return source ? [source] : [];
            });
            this.audio.preload(this.props.client, sources, MediaDeviceHandler.getAudioOutput());
        }
        const query = this.snapshot.current.query.toLocaleLowerCase();
        this.snapshot.merge({
            libraries: libraries.map((library) => ({
                ...library,
                sounds: library.sounds.filter((sound) => sound.name.toLocaleLowerCase().includes(query)),
            })),
            suggested,
            uploadLibraryId: libraries.some(
                (library) => library.id === this.snapshot.current.uploadLibraryId && library.canUpload,
            )
                ? this.snapshot.current.uploadLibraryId
                : (libraries.find((library) => library.canUpload)?.id ?? ""),
        });
    };

    public open = (): void => {
        this.suggestedOrder.clear();
        this.snapshot.merge({ error: undefined });
        this.refresh();
    };

    public setLibrary = (selectedLibraryId: string): void => {
        this.snapshot.merge({ selectedLibraryId, query: "" });
        this.refresh();
    };
    public setQuery = (query: string): void => {
        this.snapshot.merge({ query });
        this.refresh();
    };
    public setVolume = (volume: number): void => {
        if (!Number.isFinite(volume)) return;
        this.snapshot.merge({ volume: Math.max(0, Math.min(100, volume)) });
        this.audio.stop();
    };
    public setUploadLibrary = (uploadLibraryId: string): void => {
        this.snapshot.merge({ uploadLibraryId });
    };
    public setUploadName = (uploadName: string): void => {
        this.snapshot.merge({ uploadName });
    };
    public setUploadEmoji = (uploadEmoji: string): void => {
        this.snapshot.merge({ uploadEmoji });
    };

    private storedSound(sound: SoundboardSound): StoredSound | undefined {
        const event = this.rooms
            .find((room) => room.roomId === sound.libraryId)
            ?.currentState.getStateEvents(SOUNDBOARD_EVENT, sound.id);
        return event ? parseSound(event.getContent()) : undefined;
    }

    private source(sound: SoundboardSound): string | undefined {
        if (sound.libraryId === "builtin") return BUILTIN_SOUNDS.find((item) => item.id === sound.id)?.url;
        return this.storedSound(sound)?.url;
    }

    private hear = async (sound: SoundboardSound, sharedSound?: StoredSound, sender?: string): Promise<void> => {
        if (
            this.isDisposed ||
            !this.props.call.connected ||
            this.props.call.locallyLeaving ||
            SettingsStore.getValue("desktopDeafened")
        )
            return;
        const source = this.source(sound) ?? sharedSound?.url;
        if (!source) return;
        await this.audio.play(
            this.props.client,
            source,
            ((this.snapshot.current.volume / 100) * SettingsStore.getValue("desktopSpeakerVolume")) / 100,
            MediaDeviceHandler.getAudioOutput(),
            sender ? () => this.props.call.beginSoundboardPlayback(sender) : undefined,
        );
    };

    public play = async (sound: SoundboardSound, preview = false): Promise<void> => {
        if (
            !this.source(sound) ||
            this.snapshot.current.busy ||
            this.isDisposed ||
            !this.props.call.connected ||
            this.props.call.locallyLeaving
        )
            return;
        this.snapshot.merge({ error: undefined });
        const playback = this.hear(sound, undefined, preview ? undefined : this.props.client.getSafeUserId()).catch(
            (error) => this.reportError(error, _t("desktop|soundboard|playback_failed")),
        );
        if (preview) {
            await playback;
            return;
        }
        const key = `${sound.libraryId}/${sound.id}`;
        this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
        this.refresh();
        // Start playback and transmission together; homeserver latency must not delay the local sound.
        await Promise.all([
            playback,
            this.send(sound).catch((error) => this.reportError(error, _t("desktop|soundboard|send_failed"))),
        ]);
    };

    private readonly bindTransport = (): void => {
        this.unsubscribeTransport?.();
        this.unsubscribeTransport = this.props.call.soundboardTransport?.subscribe(this.receivePacket);
    };

    private readonly receivePacket = (payload: Uint8Array, sender: string): void => {
        if (payload.byteLength > 8192) return;
        let message: Record<string, unknown>;
        try {
            const decoded: unknown = JSON.parse(new TextDecoder().decode(payload));
            if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return;
            message = decoded as Record<string, unknown>;
        } catch {
            return;
        }
        if (
            !message ||
            message.type !== SOUNDBOARD_PLAY ||
            typeof message.id !== "string" ||
            message.id.length > 128 ||
            typeof message.ts !== "number" ||
            !Number.isSafeInteger(message.ts) ||
            !message.content ||
            typeof message.content !== "object"
        )
            return;
        this.receive(
            new MatrixEvent({
                event_id: `$soundboard:${sender}:${message.id}`,
                room_id: this.props.call.roomId,
                sender,
                origin_server_ts: message.ts,
                type: SOUNDBOARD_PLAY,
                content: message.content,
            }),
            true,
        );
    };

    private async send(sound: SoundboardSound): Promise<void> {
        const { client, call } = this.props;
        const hasListeners = [...call.participants].some(
            ([member, devices]) =>
                member.userId !== client.getUserId() || [...devices].some((device) => device !== client.getDeviceId()),
        );
        if (!hasListeners) return;
        const stored = this.storedSound(sound);
        const content = {
            library_id: sound.libraryId,
            sound_id: sound.id,
            ...(stored ? { sound: stored } : {}),
        };
        if (call.soundboardTransport) {
            const id = crypto.randomUUID();
            this.seen.add(`$soundboard:${client.getUserId()}:${id}`);
            if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
            await call.soundboardTransport.send(
                new TextEncoder().encode(
                    JSON.stringify({
                        type: SOUNDBOARD_PLAY,
                        id,
                        ts: Date.now(),
                        content,
                    }),
                ),
            );
            return;
        }
        await this.sendMatrix(content);
    }

    private async sendMatrix(content: { library_id: string; sound_id: string; sound?: StoredSound }): Promise<void> {
        const { client, call } = this.props;
        const room = client.getRoom(call.roomId);
        if (!room) throw new Error("room");
        // Failed sound requests are transient; never let them block later sounds or ordinary messages.
        for (const pending of room.getPendingEvents()) {
            if (pending.getType() === SOUNDBOARD_PLAY && pending.status === EventStatus.NOT_SENT)
                client.cancelPendingEvent(pending);
        }
        const txnId = client.makeTxnId();
        try {
            let response;
            try {
                response = await client.sendEvent(call.roomId, SOUNDBOARD_PLAY, content, txnId);
            } catch (error) {
                const pending = room.getPendingEvents().find((event) => event.getTxnId() === txnId);
                // The SDK blocks new events behind failed chat messages. Retry only this fresh sound through
                // the SDK's encryption/send path, leaving the failed chat messages untouched.
                if (pending?.status !== EventStatus.NOT_SENT || pending.error || this.isDisposed || !call.connected)
                    throw error;
                response = await client.resendEvent(pending, room);
            }
            if (!this.isDisposed) this.seen.add(response.event_id);
        } finally {
            const pending = room.getPendingEvents().find((event) => event.getTxnId() === txnId);
            if (pending?.status === EventStatus.NOT_SENT) client.cancelPendingEvent(pending);
        }
    }

    private readonly reportError = (error: unknown, message: string): void => {
        logger.warn("Soundboard action failed", error);
        if (!this.isDisposed) this.snapshot.merge({ error: message });
    };

    private readonly onTimeline = (
        event: MatrixEvent,
        room: Room | undefined,
        toStart: boolean | undefined,
        _removed: boolean,
        data?: { liveEvent?: boolean },
    ): void => {
        if (room?.roomId !== this.props.call.roomId || toStart || !data?.liveEvent) return;
        if (event.isEncrypted() && event.getId()) {
            this.pendingEncrypted.add(event.getId()!);
            if (this.pendingEncrypted.size > 256)
                this.pendingEncrypted.delete(this.pendingEncrypted.values().next().value!);
        }
        this.receive(event);
    };
    private readonly onDecrypted = (event: MatrixEvent): void => {
        if (event.getId() && this.pendingEncrypted.delete(event.getId()!)) this.receive(event);
    };
    private receive(event: MatrixEvent, fromTransport = false): void {
        const id = event.getId();
        const sender = event.getSender();
        const now = Date.now();
        if (
            this.isDisposed ||
            event.getType() !== SOUNDBOARD_PLAY ||
            !id ||
            this.seen.has(id) ||
            event.getRoomId() !== this.props.call.roomId ||
            !sender ||
            (!fromTransport && sender === this.props.client.getUserId()) ||
            event.getTs() < this.startedAt ||
            now - event.getTs() > 10_000 ||
            event.getTs() > now + 2000 ||
            ![...this.props.call.participants.keys()].some((member) => member.userId === sender)
        )
            return;
        this.seen.add(id);
        if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
        const content = event.getContent();
        if (typeof content.library_id !== "string" || typeof content.sound_id !== "string") return;
        const sharedSound = content.sound && typeof content.sound === "object" ? parseSound(content.sound) : undefined;
        void this.hear(
            { id: content.sound_id, libraryId: content.library_id, name: "", emoji: "" },
            content.library_id === "builtin" ? undefined : sharedSound,
            sender,
        ).catch((error) => logger.debug("Soundboard playback failed", error));
    }

    public upload = async (file: File): Promise<void> => {
        await this.perform(async () => {
            const room = this.rooms.find((room) => room.roomId === this.snapshot.current.uploadLibraryId);
            if (!room?.currentState.maySendStateEvent(SOUNDBOARD_EVENT, this.props.client.getSafeUserId()))
                throw new Error("permission");
            const clip = await SoundboardClip.load(file);
            if (this.isDisposed) {
                clip.dispose();
                return;
            }
            this.clip?.dispose();
            this.clip = clip;
            if (this.editing) this.editing.replaced = true;
            this.snapshot.merge({
                clip: {
                    name: clip.name,
                    duration: clip.duration,
                    peaks: clip.waveform(),
                    start: 0,
                    end: Math.min(10, clip.duration),
                    playing: false,
                    volume: 100,
                    editing: !!this.editing,
                    position: 0,
                },
            });
        }, _t("desktop|soundboard|decode_failed"));
    };

    public edit = async (sound: SoundboardSound): Promise<void> => {
        await this.perform(async () => {
            const room = this.rooms.find((room) => room.roomId === sound.libraryId);
            if (!room?.currentState.maySendStateEvent(SOUNDBOARD_EVENT, this.props.client.getSafeUserId()))
                throw new Error("permission");
            const original = parseSound(
                room.currentState.getStateEvents(SOUNDBOARD_EVENT, sound.id)?.getContent() ?? {},
            );
            if (!original) throw new Error("sound removed");
            this.editAbort?.abort();
            const abort = (this.editAbort = new AbortController());
            const clip = await SoundboardClip.loadStored(this.props.client, original.url, original.name, abort.signal);
            if (this.isDisposed) {
                clip.dispose();
                return;
            }
            this.clip?.dispose();
            this.clip = clip;
            this.editing = { id: sound.id, libraryId: room.roomId, original };
            this.snapshot.merge({
                uploadLibraryId: room.roomId,
                uploadName: original.name,
                uploadEmoji: original.emoji,
                clip: {
                    name: original.name,
                    duration: clip.duration,
                    peaks: clip.waveform(),
                    start: 0,
                    end: Math.min(10, clip.duration),
                    playing: false,
                    position: 0,
                    volume: 100,
                    editing: true,
                },
            });
        }, _t("desktop|soundboard|edit_failed"));
    };

    public setClipVolume = (volume: number): void => {
        const clip = this.snapshot.current.clip;
        if (!clip || this.snapshot.current.busy || !Number.isFinite(volume)) return;
        this.clip?.stop();
        this.snapshot.merge({
            clip: { ...clip, volume: Math.max(0, Math.min(100, volume)), playing: false, position: clip.start },
        });
    };

    public setClipRange = (start: number, end: number): void => {
        const clip = this.snapshot.current.clip;
        if (!clip || this.snapshot.current.busy || !Number.isFinite(start) || !Number.isFinite(end)) return;
        const minimum = Math.min(0.1, clip.duration);
        start = Math.max(0, Math.min(clip.duration - minimum, start));
        end = Math.max(start + minimum, Math.min(clip.duration, start + 10, end));
        this.clip?.stop();
        this.snapshot.merge({ clip: { ...clip, start, end, playing: false, position: start } });
    };

    public previewClip = async (): Promise<void> => {
        const clip = this.snapshot.current.clip;
        if (!clip || !this.clip || this.snapshot.current.busy) return;
        if (clip.playing) {
            this.clip.stop();
            this.snapshot.merge({ clip: { ...clip, playing: false, position: clip.start } });
            return;
        }
        try {
            await this.clip.preview(
                clip.start,
                clip.end,
                (position, playing) => {
                    if (!this.isDisposed && this.snapshot.current.clip)
                        this.snapshot.merge({ clip: { ...this.snapshot.current.clip, position, playing } });
                },
                clip.volume,
            );
        } catch (error) {
            this.reportError(error, _t("desktop|soundboard|playback_failed"));
        }
    };

    public stopClipPreview = (): void => {
        this.clip?.stop();
        const clip = this.snapshot.current.clip;
        if (clip && !this.isDisposed) this.snapshot.merge({ clip: { ...clip, playing: false, position: clip.start } });
    };

    public cancelClip = (): void => {
        if (this.snapshot.current.busy) return;
        this.clip?.dispose();
        this.clip = undefined;
        this.editing = undefined;
        this.snapshot.merge({ clip: undefined, error: undefined, uploadName: "" });
    };

    public saveClip = async (): Promise<void> => {
        await this.perform(
            async () => {
                const { uploadLibraryId, uploadName, uploadEmoji, clip } = this.snapshot.current;
                if (!clip || !this.clip) return;
                const room = this.rooms.find((room) => room.roomId === uploadLibraryId);
                if (!room?.currentState.maySendStateEvent(SOUNDBOARD_EVENT, this.props.client.getSafeUserId()))
                    throw new Error("permission");
                this.clip.stop();
                this.snapshot.merge({ clip: { ...clip, playing: false, position: clip.start } });
                const editing = this.editing;
                if (editing) {
                    const current = parseSound(
                        room.currentState.getStateEvents(SOUNDBOARD_EVENT, editing.id)?.getContent() ?? {},
                    );
                    if (
                        room.roomId !== editing.libraryId ||
                        JSON.stringify(current) !== JSON.stringify(editing.original)
                    )
                        throw new Error("sound changed");
                }
                const unchangedAudio =
                    editing &&
                    !editing.replaced &&
                    clip.start === 0 &&
                    clip.end === clip.duration &&
                    clip.volume === 100;
                const file = unchangedAudio ? undefined : this.clip.export(clip.start, clip.end, clip.volume);
                const name = (uploadName.trim() || clip.name.replace(/\.[^.]+$/, "")).slice(0, 32);
                const duration = file ? await SoundboardAudio.duration(file) : editing!.original.duration_ms / 1000;
                if (!name || this.isDisposed) return;
                const url = file ? (await this.props.client.uploadContent(file)).content_uri : editing!.original.url;
                if (this.isDisposed) return;
                await this.props.client.sendStateEvent(
                    room.roomId,
                    SOUNDBOARD_EVENT,
                    { name, emoji: uploadEmoji.slice(0, 16) || "🔊", duration_ms: Math.ceil(duration * 1000), url },
                    editing?.id ?? crypto.randomUUID(),
                );
                if (!this.isDisposed) {
                    this.clip.dispose();
                    this.clip = undefined;
                    this.editing = undefined;
                    this.snapshot.merge({ uploadName: "", clip: undefined });
                }
            },
            this.editing ? _t("desktop|soundboard|save_failed") : _t("desktop|soundboard|upload_failed"),
        );
    };
    public remove = async (sound: SoundboardSound): Promise<void> => {
        await this.perform(async () => {
            const room = this.rooms.find((room) => room.roomId === sound.libraryId);
            if (!room?.currentState.maySendStateEvent(SOUNDBOARD_EVENT, this.props.client.getSafeUserId()))
                throw new Error("permission");
            await this.props.client.sendStateEvent(room.roomId, SOUNDBOARD_EVENT, {}, sound.id);
        }, _t("desktop|soundboard|remove_failed"));
    };
    private async perform(action: () => Promise<void>, errorMessage: string): Promise<void> {
        if (this.snapshot.current.busy || this.isDisposed) return;
        this.snapshot.merge({ busy: true, error: undefined });
        try {
            await action();
        } catch (error) {
            this.reportError(error, errorMessage);
        } finally {
            if (!this.isDisposed) {
                this.snapshot.merge({ busy: false });
                this.refresh();
            }
        }
    }
}
