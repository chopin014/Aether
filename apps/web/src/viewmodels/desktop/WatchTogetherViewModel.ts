/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type WatchTogetherQueueEntry,
    type WatchTogetherViewActions,
    type WatchTogetherViewSnapshot,
} from "@element-hq/web-shared-components";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { CallEvent, type ElementCall } from "../../models/Call";
import { _t } from "../../languageHandler";
import SettingsStore from "../../settings/SettingsStore";
import {
    WatchTogetherSession,
    WatchTogetherSessionEvent,
    WatchQueueFullError,
} from "../../activities/watch-together/WatchTogetherSession";
import { WatchPlayerSync } from "../../activities/watch-together/WatchPlayerSync";
import { YouTubeEmbedPlayer } from "../../activities/watch-together/YouTubeEmbedPlayer";
import { HtmlMediaPlayer } from "../../activities/watch-together/HtmlMediaPlayer";
import type { WatchPlayer, WatchPlayerError } from "../../activities/watch-together/WatchPlayer";
import { WATCH_RATES, type WatchItem, type WatchState } from "../../activities/watch-together/WatchTogetherProtocol";
import {
    fetchMetadata,
    parsePlayableLink,
    PlayableLinkRefusedError,
    sourceUrl,
    thumbnailUrl,
    type PlayableLink,
    type PlayableMetadata,
} from "../../activities/watch-together/WatchTogetherSources";

interface Props {
    client: MatrixClient;
    call: ElementCall;
    /** Builds a player; replaced in tests. */
    createPlayer?: (source: WatchItem["source"]) => WatchPlayer;
}

const VOLUME_KEY = "aether_watch_together_volume";
const DEFAULT_VOLUME = 70;
/** A title lookup slower than this is skipped; the player shows the title once it loads. */
const METADATA_TIMEOUT_MS = 3000;
/** A first state this close to the start of its item was just started, not joined in the middle. */
const JUST_STARTED_SECONDS = 3;

function readVolume(): number {
    try {
        const stored = Number(localStorage.getItem(VOLUME_KEY));
        return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(stored)
            ? Math.max(0, Math.min(100, stored))
            : DEFAULT_VOLUME;
    } catch {
        return DEFAULT_VOLUME;
    }
}

function playerErrorText(error: WatchPlayerError): string {
    switch (error) {
        case "not_embeddable":
            return _t("desktop|watch_together|error_not_embeddable");
        case "not_found":
            return _t("desktop|watch_together|error_not_found");
        default:
            return _t("desktop|watch_together|error_unplayable");
    }
}

/**
 * Watch Together for one call: a shared YouTube or media player that everyone in the call controls. Playback runs on
 * each device at that device's own quality; only the player state travels through the call.
 */
export class WatchTogetherViewModel
    extends BaseViewModel<WatchTogetherViewSnapshot, Props>
    implements WatchTogetherViewActions
{
    private static readonly shared = new WeakMap<ElementCall, { vm: WatchTogetherViewModel; owners: number }>();

    /** One player per call, shared by every view of it, so moving between views never restarts playback. */
    public static acquire(props: Props): { vm: WatchTogetherViewModel; release: () => void } {
        let entry = this.shared.get(props.call);
        if (!entry) {
            entry = { vm: new WatchTogetherViewModel(props), owners: 0 };
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

    private readonly session: WatchTogetherSession;
    private readonly sync: WatchPlayerSync;
    private host: HTMLElement | null = null;
    private noticeId = 0;
    private addAbort?: AbortController;

    public constructor(props: Props) {
        super(props, {
            connected: false,
            active: false,
            title: "",
            playing: false,
            ended: false,
            startingIn: null,
            buffering: false,
            hasVideo: true,
            embedHandlesClicks: true,
            position: 0,
            duration: null,
            rate: 1,
            rates: WATCH_RATES,
            hasPrevious: false,
            hasNext: false,
            queue: [],
            volume: readVolume(),
            deafened: !!SettingsStore.getValue("desktopDeafened"),
            draft: "",
            adding: false,
        });
        this.session = new WatchTogetherSession(props.client.getSafeUserId());
        const createPlayer =
            props.createPlayer ??
            ((source: WatchItem["source"]): WatchPlayer =>
                source === "youtube" ? new YouTubeEmbedPlayer() : new HtmlMediaPlayer());
        this.sync = new WatchPlayerSync(this.session, {
            createPlayer,
            onPlayerChanged: this.onPlayerChanged,
            onTick: this.refresh,
        });
        this.applyVolume();
        this.disposables.track(() => {
            this.addAbort?.abort();
            this.sync.dispose();
            this.session.dispose();
        });
        this.session.on(WatchTogetherSessionEvent.Changed, this.onSessionChanged);
        this.disposables.track(() => this.session.off(WatchTogetherSessionEvent.Changed, this.onSessionChanged));
        this.disposables.trackListener(props.call, CallEvent.SoundboardTransport, this.bindTransport);
        const deafenRef = SettingsStore.watchSetting("desktopDeafened", null, () => {
            this.snapshot.merge({ deafened: !!SettingsStore.getValue("desktopDeafened") });
            this.applyVolume();
        });
        this.disposables.track(() => SettingsStore.unwatchSetting(deafenRef));
        this.bindTransport();
    }

    public setDraft = (draft: string): void => {
        this.snapshot.merge({ draft, addError: undefined });
    };

    public submitDraft = async (mode: "play" | "queue"): Promise<void> => {
        const link = parsePlayableLink(this.snapshot.current.draft);
        if (!link) {
            this.snapshot.merge({ addError: _t("desktop|watch_together|error_not_a_link") });
            return;
        }
        if (await this.add(link, mode)) this.snapshot.merge({ draft: "" });
    };

    public addLink = (text: string): boolean => {
        const link = parsePlayableLink(text);
        if (!link || !this.session.connected) return false;
        void this.add(link, this.session.active ? "queue" : "play");
        return true;
    };

    public togglePlaying = (): void => {
        const state = this.session.state;
        if (!state) return;
        this.session.setPlaying(state.ended || !state.playing);
    };

    public seek = (seconds: number): void => {
        const duration = this.sync.currentPlayer?.status().duration;
        this.session.seek(duration ? Math.min(seconds, Math.max(0, duration - 0.5)) : seconds);
    };

    public setRate = (rate: number): void => this.session.setRate(rate);
    public next = (): void => this.session.next();
    public previous = (): void => this.session.previous();
    public stop = (): void => this.session.stop();

    public playItem = (id: string): void => {
        const index = this.session.state?.items.findIndex((item) => item.id === id) ?? -1;
        if (index >= 0) this.session.jump(index);
    };

    public removeItem = (id: string): void => this.session.remove(id);

    public setVolume = (volume: number): void => {
        const clamped = Math.max(0, Math.min(100, Math.round(volume)));
        this.snapshot.merge({ volume: clamped });
        try {
            localStorage.setItem(VOLUME_KEY, String(clamped));
        } catch {
            // The volume still applies for this session.
        }
        this.applyVolume();
    };

    public attachPlayer = (host: HTMLElement | null): void => {
        this.host = host;
        this.placePlayer(this.sync.currentPlayer);
    };

    public openSource = (): void => {
        const item = this.session.current;
        if (item) window.open(sourceUrl(item), "_blank", "noopener,noreferrer");
    };

    private readonly bindTransport = (): void => {
        this.session.setTransport(this.props.call.soundboardTransport ?? null);
        this.refresh();
    };

    private applyVolume(): void {
        const { volume, deafened } = this.snapshot.current;
        this.sync.setVolume(deafened ? 0 : volume / 100);
    }

    private readonly onPlayerChanged = (player: WatchPlayer | null): void => {
        this.placePlayer(player);
    };

    private placePlayer(player: WatchPlayer | null): void {
        if (!this.host) return;
        if (!player) {
            this.host.replaceChildren();
            return;
        }
        if (player.element.parentElement === this.host) return;
        this.sync.notePlayerMoved();
        this.host.replaceChildren(player.element);
    }

    private async add(link: PlayableLink, mode: "play" | "queue"): Promise<boolean> {
        if (!this.session.connected) {
            this.snapshot.merge({ addError: _t("desktop|watch_together|error_not_connected") });
            return false;
        }
        this.addAbort?.abort();
        const abort = new AbortController();
        this.addAbort = abort;
        this.snapshot.merge({ adding: true, addError: undefined });
        let metadata: PlayableMetadata = {};
        try {
            metadata = await fetchMetadata(
                link,
                fetch,
                AbortSignal.any([abort.signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]),
            );
        } catch (error) {
            if (abort.signal.aborted || this.isDisposed) return false;
            if (error instanceof PlayableLinkRefusedError) {
                this.snapshot.merge({
                    adding: false,
                    addError:
                        error.reason === "not_embeddable"
                            ? _t("desktop|watch_together|error_not_embeddable")
                            : _t("desktop|watch_together|error_not_found"),
                });
                return false;
            }
            // A slow lookup is not worth waiting for; the player reports the title once it loads.
        }
        if (abort.signal.aborted || this.isDisposed) return false;
        const item: WatchItem = {
            id: crypto.randomUUID().replaceAll("-", "").slice(0, 12),
            ...link,
            ...metadata,
            addedBy: this.props.client.getSafeUserId(),
        };
        try {
            if (mode === "play") this.session.playNow([item]);
            else this.session.enqueue([item]);
        } catch (error) {
            const full = error instanceof WatchQueueFullError;
            if (!full) logger.warn("Watch Together: could not add", error);
            this.snapshot.merge({
                adding: false,
                addError: full ? _t("desktop|watch_together|error_queue_full") : _t("desktop|watch_together|error_add"),
            });
            return false;
        }
        this.snapshot.merge({ adding: false });
        return true;
    }

    private displayName(userId: string): string {
        return this.props.client.getRoom(this.props.call.roomId)?.getMember(userId)?.rawDisplayName || userId;
    }

    private itemTitle(item: WatchItem, playerTitle?: string): string {
        if (item.title) return item.title;
        if (playerTitle) return playerTitle;
        if (item.source === "youtube") return _t("desktop|watch_together|youtube_video");
        return new URL(item.ref).hostname;
    }

    /** Tells people what someone else just did, so a sudden pause or skip is never a mystery. */
    private readonly onSessionChanged = (
        state: WatchState | null,
        previous: WatchState | null,
        local: boolean,
    ): void => {
        this.refresh();
        if (local || !state) return;
        const name = this.displayName(state.author);
        const item = state.items[state.index];
        const title = item ? this.itemTitle(item) : "";
        let text: string | undefined;
        if (!previous) {
            // The first state this device hears of is either someone starting something just now, or the call
            // catching up a device that joined late, which lands somewhere in the middle and needs no notice.
            if (item && this.session.position() < JUST_STARTED_SECONDS)
                text = _t("desktop|watch_together|notice_started", { name, title });
        } else if (!state.items.length) {
            if (previous.items.length) text = _t("desktop|watch_together|notice_stopped", { name });
        } else if (!previous.items.length || state.session !== previous.session) {
            text = _t("desktop|watch_together|notice_started", { name, title });
        } else if (state.items[state.index]?.id !== previous.items[previous.index]?.id) {
            const finished = previous.items.length === state.items.length && state.index === previous.index + 1;
            const duration = this.sync.currentPlayer?.status().duration;
            const atEnd = finished && duration !== null && duration !== undefined && this.lastPosition >= duration - 3;
            text = atEnd
                ? _t("desktop|watch_together|notice_now_playing", { title })
                : _t("desktop|watch_together|notice_skipped", { name, title });
        } else if (state.items.length > previous.items.length) {
            const added = state.items[state.items.length - 1];
            text = _t("desktop|watch_together|notice_queued", { name, title: this.itemTitle(added) });
        } else if (state.ended && !previous.ended) {
            text = undefined;
        } else if (state.playing !== previous.playing) {
            text = state.playing
                ? _t("desktop|watch_together|notice_resumed", { name })
                : _t("desktop|watch_together|notice_paused", { name });
        } else if (state.rate !== previous.rate) {
            text = _t("desktop|watch_together|notice_rate", { name, rate: `${state.rate}×` });
        } else if (Math.abs(state.position - this.lastPosition) > 2) {
            text = _t("desktop|watch_together|notice_seeked", { name });
        }
        if (text) this.snapshot.merge({ notice: { id: ++this.noticeId, text } });
    };

    /** The position shown last, to tell a seek from ordinary playback when someone else's change arrives. */
    private lastPosition = 0;

    private readonly refresh = (): void => {
        if (this.isDisposed) return;
        const session = this.session;
        const state = session.state;
        const item = session.current;
        if (!state || !item) {
            this.lastPosition = 0;
            this.snapshot.merge({
                connected: session.connected,
                active: false,
                title: "",
                subtitle: undefined,
                addedBy: undefined,
                thumbnailUrl: undefined,
                sourceName: undefined,
                playing: false,
                ended: false,
                startingIn: null,
                buffering: false,
                playerError: undefined,
                position: 0,
                duration: null,
                queue: [],
                hasNext: false,
                hasPrevious: false,
            });
            return;
        }
        const status = this.sync.currentPlayer?.itemId === item.id ? this.sync.currentPlayer.status() : undefined;
        const expected = session.position();
        const position =
            Math.round((status?.ready && status.time !== null ? status.time : Math.max(0, expected)) * 10) / 10;
        this.lastPosition = position;
        const queue: WatchTogetherQueueEntry[] = state.items.map((entry, index) => ({
            id: entry.id,
            title: this.itemTitle(entry, index === state.index ? status?.title : undefined),
            subtitle: entry.channel,
            thumbnailUrl: thumbnailUrl(entry),
            addedBy: this.displayName(entry.addedBy),
            current: index === state.index,
        }));
        this.snapshot.merge({
            connected: session.connected,
            active: true,
            title: queue[state.index].title,
            subtitle: item.channel,
            addedBy: this.displayName(item.addedBy),
            thumbnailUrl: thumbnailUrl(item),
            sourceName: item.source === "youtube" ? "YouTube" : new URL(item.ref).hostname,
            playing: state.playing && !state.ended,
            ended: state.ended,
            startingIn: state.playing && expected < 0 ? Math.ceil(-expected) : null,
            buffering: !!status?.buffering,
            hasVideo: status?.hasVideo ?? true,
            embedHandlesClicks: item.source === "youtube",
            playerError: status?.error ? playerErrorText(status.error) : undefined,
            position,
            duration: status?.duration ?? null,
            rate: state.rate,
            queue,
            hasNext: state.index + 1 < state.items.length,
            hasPrevious: state.index > 0,
        });
    };
}
