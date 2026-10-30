/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

// oxlint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MatrixEvent,
    MatrixEventEvent,
    EventStatus,
    PendingEventOrdering,
    MatrixError,
    Room,
    RoomEvent,
    type MatrixClient,
    type RoomMember,
} from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { SoundboardClip } from "../../audio/soundboard/SoundboardClip";
import { SoundboardViewModel } from "./SoundboardViewModel";
import { CallEvent, ConnectionState, type ElementCall } from "../../models/Call";
import { SOUNDBOARD_EVENT, SOUNDBOARD_PLAY, SoundboardAudio } from "../../audio/soundboard/Soundboard";
import SettingsStore from "../../settings/SettingsStore";
import type SpaceStore from "../../stores/spaces/SpaceStore";
import { UPDATE_SELECTED_SPACE } from "../../stores/spaces";
import type { SoundboardTransport } from "../../audio/soundboard/SoundboardTransport";

const builtin = { id: "quack", name: "Quack", emoji: "🦆", libraryId: "builtin" };

describe("SoundboardViewModel", () => {
    let client: MatrixClient;
    let call: ElementCall;
    let room: Room;
    let space: Room;
    let vm: SoundboardViewModel;
    let spaceStore: SpaceStore;
    const sound = { name: "Hello", emoji: "👋", url: "mxc://example.org/hello", duration_ms: 1500 };
    beforeEach(() => {
        client = stubClient();
        call = Object.assign(new EventEmitter(), {
            roomId: "!voice:example.org",
            connected: true,
            locallyLeaving: false,
            participants: new Map([[{ userId: "@bob:example.org" } as RoomMember, new Set(["DEVICE"])]]),
        }) as unknown as ElementCall;
        room = new Room(call.roomId, client, client.getSafeUserId(), {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        space = new Room("!space:example.org", client, client.getSafeUserId());
        space.name = "My server";
        vi.spyOn(space, "isSpaceRoom").mockReturnValue(true);
        vi.spyOn(space, "getMyMembership").mockReturnValue("join");
        space.currentState.setStateEvents([
            new MatrixEvent({
                room_id: space.roomId,
                type: "m.space.child",
                state_key: room.roomId,
                content: { via: ["example.org"] },
            }),
            new MatrixEvent({ room_id: space.roomId, type: SOUNDBOARD_EVENT, state_key: "hello", content: sound }),
        ]);
        vi.spyOn(room.currentState, "maySendStateEvent").mockReturnValue(true);
        vi.spyOn(space.currentState, "maySendStateEvent").mockReturnValue(true);
        vi.mocked(client.getRooms).mockReturnValue([room, space]);
        vi.mocked(client.getRoom).mockImplementation((id) =>
            id === room.roomId ? room : id === space.roomId ? space : null,
        );
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            (key) => ({ desktopDeafened: false, desktopSpeakerVolume: 100 })[key as string] ?? false,
        );
        vi.spyOn(SettingsStore, "watchSetting").mockReturnValue("watch");
        vi.spyOn(SettingsStore, "unwatchSetting").mockImplementation(() => {});
        vi.spyOn(SoundboardAudio.prototype, "preload").mockImplementation(() => {});
        vi.spyOn(SoundboardAudio.prototype, "play").mockResolvedValue();
        vi.mocked(client.sendEvent).mockResolvedValue({ event_id: "$sent" });
        spaceStore = Object.assign(new EventEmitter(), { activeSpace: space.roomId }) as unknown as SpaceStore;
        vm = new SoundboardViewModel({ client, call, spaceStore });
    });
    afterEach(() => {
        vm?.dispose();
        vi.restoreAllMocks();
    });
    function event(overrides = {}) {
        return new MatrixEvent({
            event_id: "$play",
            room_id: room.roomId,
            sender: "@bob:example.org",
            origin_server_ts: Date.now(),
            type: SOUNDBOARD_PLAY,
            content: { library_id: "builtin", sound_id: "quack" },
            ...overrides,
        });
    }
    function receive(ev: MatrixEvent, live = true) {
        client.emit(RoomEvent.Timeline, ev, room, false, false, { liveEvent: live, timeline: room.getLiveTimeline() });
    }
    it("loads joined parent libraries, ignores invalid entries and searches names", () => {
        expect(vm.getSnapshot().libraries.find((library) => library.id === space.roomId)?.sounds).toEqual([
            { id: "hello", libraryId: space.roomId, name: "Hello", emoji: "👋" },
        ]);
        vm.setQuery("HEL");
        expect(vm.getSnapshot().libraries.flatMap((library) => library.sounds)).toHaveLength(1);
        space.currentState.setStateEvents([
            new MatrixEvent({ room_id: space.roomId, type: SOUNDBOARD_EVENT, state_key: "hello", content: {} }),
        ]);
        vm.setQuery("");
        expect(vm.getSnapshot().libraries.find((library) => library.id === space.roomId)?.sounds).toHaveLength(0);
    });
    it("uses Matrix avatars and clears a search when navigating to a library", () => {
        vi.spyOn(space, "getMxcAvatarUrl").mockReturnValue("mxc://example.org/avatar");
        vm.setQuery("missing");
        vm.setLibrary(space.roomId);
        const snapshot = vm.getSnapshot();
        expect(snapshot.query).toBe("");
        expect(snapshot.selectedLibraryId).toBe(space.roomId);
        expect(snapshot.libraries.find((library) => library.id === space.roomId)?.avatarUrl).toContain("avatar");
        expect(snapshot.libraries.find((library) => library.id === space.roomId)?.sounds).toHaveLength(1);
    });
    it("keeps repeated solo playback entirely local", async () => {
        Object.assign(call, {
            participants: new Map([[{ userId: client.getUserId() } as RoomMember, new Set([client.getDeviceId()!])]]),
        });
        const transport: SoundboardTransport = {
            send: vi.fn().mockResolvedValue(undefined),
            subscribe: vi.fn(() => vi.fn()),
        };
        Object.assign(call, { soundboardTransport: transport });
        call.emit(CallEvent.SoundboardTransport);
        await Promise.all(Array.from({ length: 20 }, () => vm.play(builtin)));
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(20);
        expect(transport.send).not.toHaveBeenCalled();
        expect(client.sendEvent).not.toHaveBeenCalled();
        expect(vm.getSnapshot().error).toBeUndefined();
    });
    it("delivers rapid sounds between two client models over call data without Matrix sends", async () => {
        const bob = stubClient();
        vi.mocked(bob.getUserId).mockReturnValue("@bob:example.org");
        vi.mocked(bob.getSafeUserId).mockReturnValue("@bob:example.org");
        vi.mocked(bob.getRoom).mockReturnValue(room);
        vi.mocked(bob.getRooms).mockReturnValue([room, space]);
        let fromAlice!: Parameters<SoundboardTransport["subscribe"]>[0];
        let fromBob!: Parameters<SoundboardTransport["subscribe"]>[0];
        const unsubscribeAlice = vi.fn();
        const unsubscribeBob = vi.fn();
        const aliceTransport: SoundboardTransport = {
            send: vi.fn(async (payload) => fromAlice(payload, client.getSafeUserId())),
            subscribe: (listener) => {
                fromBob = listener;
                return unsubscribeAlice;
            },
        };
        const bobTransport: SoundboardTransport = {
            send: vi.fn(async (payload) => fromBob(payload, "@bob:example.org")),
            subscribe: (listener) => {
                fromAlice = listener;
                return unsubscribeBob;
            },
        };
        Object.assign(call, { soundboardTransport: aliceTransport });
        call.emit(CallEvent.SoundboardTransport);
        const bobCall = Object.assign(new EventEmitter(), {
            roomId: room.roomId,
            connected: true,
            locallyLeaving: false,
            soundboardTransport: bobTransport,
            participants: new Map([[{ userId: client.getUserId() } as RoomMember, new Set(["DEVICE"])]]),
        }) as unknown as ElementCall;
        const bobVm = new SoundboardViewModel({ client: bob, call: bobCall, spaceStore });
        try {
            await Promise.all([vm.play(builtin), vm.play({ ...builtin, id: "airhorn" }), vm.play(builtin)]);
            expect(aliceTransport.send).toHaveBeenCalledTimes(3);
            expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(6);
            await bobVm.play(builtin);
            expect(bobTransport.send).toHaveBeenCalledOnce();
            expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(8);
            expect(client.sendEvent).not.toHaveBeenCalled();
            expect(bob.sendEvent).not.toHaveBeenCalled();
        } finally {
            bobVm.dispose();
        }
        expect(unsubscribeBob).toHaveBeenCalledOnce();
        vm.dispose();
        expect(unsubscribeAlice).toHaveBeenCalledOnce();
    });
    it("validates call data, suppresses duplicates and releases old transport subscriptions", async () => {
        let listener!: Parameters<SoundboardTransport["subscribe"]>[0];
        const unsubscribe = vi.fn();
        const transport: SoundboardTransport = {
            send: vi.fn().mockResolvedValue(undefined),
            subscribe: (callback) => {
                listener = callback;
                return unsubscribe;
            },
        };
        Object.assign(call, { soundboardTransport: transport });
        call.emit(CallEvent.SoundboardTransport);
        const packet = {
            type: SOUNDBOARD_PLAY,
            id: "request",
            ts: Date.now(),
            content: { library_id: "builtin", sound_id: "quack" },
        };
        const data = (content: unknown) => new TextEncoder().encode(JSON.stringify(content));
        listener(data(packet), "@outsider:example.org");
        listener(data({ ...packet, ts: Date.now() - 20_000 }), "@bob:example.org");
        listener(data({ ...packet, ts: "invalid" }), "@bob:example.org");
        listener(new Uint8Array(8193), "@bob:example.org");
        listener(new Uint8Array([255]), "@bob:example.org");
        expect(SoundboardAudio.prototype.play).not.toHaveBeenCalled();
        listener(data(packet), "@bob:example.org");
        listener(data(packet), "@bob:example.org");
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledOnce();
        Object.assign(call, { soundboardTransport: null });
        call.emit(CallEvent.SoundboardTransport);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
    it("previews locally and broadcasts a play request only for shared playback", async () => {
        await vm.play(builtin, true);
        expect(client.sendEvent).not.toHaveBeenCalled();
        await vm.play(builtin);
        expect(client.sendEvent).toHaveBeenCalledWith(
            room.roomId,
            SOUNDBOARD_PLAY,
            {
                library_id: "builtin",
                sound_id: "quack",
            },
            expect.any(String),
        );
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(2);
        await vm.play(builtin);
        expect(client.sendEvent).toHaveBeenCalledTimes(2);
        expect(vm.getSnapshot().suggested[0].id).toBe("airhorn");
        vm.open();
        expect(vm.getSnapshot().suggested[0].id).toBe("quack");
    });
    it("starts local audio without waiting for the homeserver and leaves previews responsive", async () => {
        let acknowledge!: (response: { event_id: string }) => void;
        vi.mocked(client.sendEvent).mockReturnValue(
            new Promise((resolve) => {
                acknowledge = resolve;
            }),
        );
        const sending = vm.play(builtin);
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledOnce();
        expect(vm.getSnapshot().busy).toBe(false);
        await vm.play(builtin, true);
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(2);
        expect(client.sendEvent).toHaveBeenCalledOnce();
        acknowledge({ event_id: "$sent" });
        await sending;
        receive(event({ event_id: "$sent", sender: client.getUserId() }));
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(2);
    });
    it("broadcasts rapid repeats and different sounds while earlier requests are pending", async () => {
        let acknowledge!: (response: { event_id: string }) => void;
        vi.mocked(client.sendEvent).mockReturnValue(
            new Promise((resolve) => {
                acknowledge = resolve;
            }),
        );
        const airhorn = { ...builtin, id: "airhorn", name: "Airhorn" };
        const requests = [vm.play(builtin), vm.play(airhorn), vm.play(builtin)];
        expect(client.sendEvent).toHaveBeenCalledTimes(3);
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(3);
        expect(client.sendEvent).toHaveBeenNthCalledWith(
            2,
            room.roomId,
            SOUNDBOARD_PLAY,
            {
                library_id: "builtin",
                sound_id: "airhorn",
            },
            expect.any(String),
        );
        acknowledge({ event_id: "$sent" });
        await Promise.all(requests);
    });
    it("plays consecutive participant sounds and repeats without a cooldown but still ignores duplicate events", () => {
        const first = event();
        const other = event({ event_id: "$other", content: { library_id: "builtin", sound_id: "airhorn" } });
        const repeat = event({ event_id: "$repeat" });
        receive(first);
        receive(other);
        receive(repeat);
        receive(first);
        receive(other);
        receive(repeat);
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(3);
    });
    it("keeps frequently used tiles in place until the picker is reopened", async () => {
        vm.open();
        const ids = () => vm.getSnapshot().suggested.map((sound) => `${sound.libraryId}/${sound.id}`);
        const original = ids();
        await vm.play(builtin);
        await vm.play(builtin);
        vm.setQuery("quack");
        vm.setLibrary("builtin");
        expect(ids()).toEqual(original);
        vm.open();
        expect(vm.getSnapshot().suggested[0].id).toBe("quack");
        const reopened = ids();
        await vm.play({ ...builtin, id: "sad-horn", name: "Sad horn" });
        expect(ids()).toEqual(reopened);
    });
    it("loads sound libraries from joined Spaces outside the call's parent Space", async () => {
        const other = new Room("!other:example.org", client, client.getSafeUserId());
        other.name = "Other server";
        vi.spyOn(other, "isSpaceRoom").mockReturnValue(true);
        vi.spyOn(other, "getMyMembership").mockReturnValue("join");
        other.currentState.setStateEvents([
            new MatrixEvent({ room_id: other.roomId, type: SOUNDBOARD_EVENT, state_key: "hello", content: sound }),
        ]);
        vi.mocked(client.getRooms).mockReturnValue([room, space, other]);
        vm.open();
        const library = vm.getSnapshot().libraries.find((library) => library.id === other.roomId)!;
        expect(library.sounds).toHaveLength(1);
        await vm.play(library.sounds[0]);
        expect(client.sendEvent).toHaveBeenCalledWith(
            room.roomId,
            SOUNDBOARD_PLAY,
            {
                library_id: other.roomId,
                sound_id: "hello",
                sound,
            },
            expect.any(String),
        );
        vi.spyOn(other, "getMyMembership").mockReturnValue("leave");
        vm.open();
        expect(vm.getSnapshot().libraries.some((library) => library.id === other.roomId)).toBe(false);
    });
    it("places the active Space directly after Aether sounds and responds to Space changes", () => {
        const other = new Room("!other:example.org", client, client.getSafeUserId());
        vi.spyOn(other, "isSpaceRoom").mockReturnValue(true);
        vi.spyOn(other, "getMyMembership").mockReturnValue("join");
        vi.mocked(client.getRooms).mockReturnValue([room, other, space]);
        vm.open();
        expect(
            vm
                .getSnapshot()
                .libraries.map((library) => library.id)
                .slice(0, 2),
        ).toEqual(["builtin", space.roomId]);
        Object.assign(spaceStore, { activeSpace: other.roomId });
        spaceStore.emit(UPDATE_SELECTED_SPACE);
        expect(
            vm
                .getSnapshot()
                .libraries.map((library) => library.id)
                .slice(0, 2),
        ).toEqual(["builtin", other.roomId]);
    });
    it("plays a participant's shared sound without membership in its source Space and validates the media reference", () => {
        receive(event({ content: { library_id: "!other:example.org", sound_id: "hello", sound } }));
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledWith(
            client,
            sound.url,
            expect.any(Number),
            expect.any(String),
        );
        vi.mocked(SoundboardAudio.prototype.play).mockClear();
        for (const [index, change] of [{ url: "https://example.org/arbitrary" }, { duration_ms: 10_001 }].entries()) {
            receive(
                event({
                    event_id: `$bad-${index}`,
                    content: {
                        library_id: "!other:example.org",
                        sound_id: "hello",
                        sound: { ...sound, ...change },
                    },
                }),
            );
        }
        receive(
            event({
                event_id: "$outsider",
                sender: "@outsider:example.org",
                content: {
                    library_id: "!other:example.org",
                    sound_id: "hello",
                    sound,
                },
            }),
        );
        expect(SoundboardAudio.prototype.play).not.toHaveBeenCalled();
    });
    it("retries only the fresh sound blocked behind failed chat and removes stale failed sound requests", async () => {
        const pending = (type: string, txnId: string) => {
            const ev = event({ event_id: `~${txnId}`, type, sender: client.getUserId() });
            ev.setTxnId(txnId);
            ev.setStatus(EventStatus.NOT_SENT);
            room.addPendingEvent(ev, txnId);
            return ev;
        };
        const chat = pending("m.room.message", "chat");
        const stale = pending(SOUNDBOARD_PLAY, "stale");
        vi.mocked(client.cancelPendingEvent).mockImplementation((ev) =>
            room.updatePendingEvent(ev, EventStatus.CANCELLED),
        );
        let fresh!: MatrixEvent;
        vi.mocked(client.makeTxnId).mockReturnValue("fresh");
        vi.mocked(client.sendEvent).mockImplementation(async () => {
            fresh = pending(SOUNDBOARD_PLAY, "fresh");
            throw new Error("Event blocked by other events not yet sent");
        });
        vi.mocked(client.resendEvent).mockResolvedValue({ event_id: "$sent" });
        await vm.play(builtin);
        expect(client.cancelPendingEvent).toHaveBeenCalledWith(stale);
        expect(client.resendEvent).toHaveBeenCalledWith(fresh, room);
        expect(client.resendEvent).toHaveBeenCalledOnce();
        expect(client.cancelPendingEvent).not.toHaveBeenCalledWith(chat);
        expect(room.getPendingEvents()).toContain(chat);
        expect(vm.getSnapshot().error).toBeUndefined();
    });
    it("cleans up genuinely failed sound requests and reports a send error without upload instructions", async () => {
        let failed!: MatrixEvent;
        vi.mocked(client.makeTxnId).mockReturnValue("failed");
        vi.mocked(client.sendEvent).mockImplementation(async () => {
            failed = event({ event_id: "~failed" });
            failed.setTxnId("failed");
            failed.setStatus(EventStatus.NOT_SENT);
            failed.error = new MatrixError({ errcode: "M_FORBIDDEN", error: "forbidden" });
            room.addPendingEvent(failed, "failed");
            throw failed.error;
        });
        await vm.play(builtin);
        expect(client.resendEvent).not.toHaveBeenCalled();
        expect(client.cancelPendingEvent).toHaveBeenCalledWith(failed);
        expect(vm.getSnapshot().error).toBe(
            "Could not send this sound to the call. Check your connection and try again.",
        );
        expect(vm.getSnapshot().error).not.toContain("512");
        vm.open();
        expect(vm.getSnapshot().error).toBeUndefined();
    });
    it("reports playback errors separately from uploads", async () => {
        vi.mocked(SoundboardAudio.prototype.play).mockRejectedValue(new Error("audio device"));
        await vm.play(builtin, true);
        expect(vm.getSnapshot().error).toBe("Could not play this sound. Try another sound or check your audio output.");
        expect(client.sendEvent).not.toHaveBeenCalled();
    });
    it("preloads available libraries for listeners before any sound is played", () => {
        expect(SoundboardAudio.prototype.preload).toHaveBeenCalledWith(
            client,
            expect.arrayContaining([sound.url, expect.stringContaining("soundboard-quack.wav")]),
            expect.any(String),
        );
        expect(SoundboardAudio.prototype.play).not.toHaveBeenCalled();
    });
    it("waits for connection before preloading the listener's libraries", () => {
        vm.dispose();
        Object.assign(call, { connected: false });
        vi.mocked(SoundboardAudio.prototype.preload).mockClear();
        vm = new SoundboardViewModel({ client, call, spaceStore });
        expect(SoundboardAudio.prototype.preload).not.toHaveBeenCalled();
        Object.assign(call, { connected: true });
        call.emit(CallEvent.ConnectionState, ConnectionState.Connected, ConnectionState.Disconnected);
        expect(SoundboardAudio.prototype.preload).toHaveBeenCalledOnce();
    });
    it("still plays locally when transmission fails and reports the failure", async () => {
        vi.mocked(client.sendEvent).mockRejectedValue(new Error("offline"));
        await vm.play(builtin);
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledOnce();
        expect(vm.getSnapshot().error).toBeTruthy();
    });
    it("plays live participant requests once and ignores history, stale, foreign and non-participant requests", () => {
        receive(event(), false);
        receive(event({ origin_server_ts: Date.now() - 20_000 }));
        receive(event({ sender: "@outsider:example.org" }));
        receive(event({ room_id: "!other:example.org" }));
        expect(SoundboardAudio.prototype.play).not.toHaveBeenCalled();
        receive(event());
        receive(event());
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledTimes(1);
    });
    it("handles live encrypted requests after decryption but ignores decrypted history", () => {
        const encrypted = event({ event_id: "$encrypted", type: "m.room.encrypted" });
        receive(encrypted);
        client.emit(MatrixEventEvent.Decrypted, event({ event_id: "$history" }));
        expect(SoundboardAudio.prototype.play).not.toHaveBeenCalled();
        client.emit(MatrixEventEvent.Decrypted, event({ event_id: "$encrypted" }));
        expect(SoundboardAudio.prototype.play).toHaveBeenCalledOnce();
    });
    it("suppresses own echoes, unknown media, deafen and playback after leave", async () => {
        receive(event({ sender: client.getUserId() }));
        receive(event({ content: { library_id: "builtin", sound_id: "invalid" } }));
        expect(SoundboardAudio.prototype.play).not.toHaveBeenCalled();
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        await vm.play(builtin, true);
        expect(SoundboardAudio.prototype.play).not.toHaveBeenCalled();
        Object.assign(call, { locallyLeaving: true });
        await vm.play(builtin);
        expect(client.sendEvent).not.toHaveBeenCalled();
    });
    it("uploads validated media with an independent state key and removes library entries", async () => {
        vi.spyOn(SoundboardAudio, "duration").mockResolvedValue(1.5);
        vi.mocked(client.uploadContent).mockResolvedValue({ content_uri: sound.url });
        vm.setUploadLibrary(space.roomId);
        vm.setUploadName("Hello");
        vm.setUploadEmoji("👋");
        const file = new File(["audio"], "hello.wav", { type: "audio/wav" });
        const dispose = vi.fn();
        vi.spyOn(SoundboardClip, "load").mockResolvedValue({
            name: file.name,
            duration: 1.5,
            waveform: () => [0.5, 1],
            stop: vi.fn(),
            dispose,
            export: () => file,
        } as unknown as SoundboardClip);
        await vm.upload(file);
        expect(client.uploadContent).not.toHaveBeenCalled();
        expect(vm.getSnapshot().clip?.end).toBe(1.5);
        await vm.saveClip();
        expect(dispose).toHaveBeenCalledOnce();
        expect(vm.getSnapshot().clip).toBeUndefined();
        expect(client.uploadContent).toHaveBeenCalledWith(file);
        expect(client.sendStateEvent).toHaveBeenCalledWith(space.roomId, SOUNDBOARD_EVENT, sound, expect.any(String));
        await vm.remove({ id: "hello", libraryId: space.roomId, name: "Hello", emoji: "👋" });
        expect(client.sendStateEvent).toHaveBeenLastCalledWith(space.roomId, SOUNDBOARD_EVENT, {}, "hello");
    });
    it("rejects uploads without permissions or with invalid media and reports send failures", async () => {
        vi.spyOn(room.currentState, "maySendStateEvent").mockReturnValue(false);
        vm.setUploadLibrary(room.roomId);
        await vm.upload(new File(["x"], "bad.wav"));
        expect(client.uploadContent).not.toHaveBeenCalled();
        expect(vm.getSnapshot().error).toBeTruthy();
        vi.spyOn(SoundboardClip, "load").mockRejectedValue(new Error("decode"));
        vm.setUploadLibrary(space.roomId);
        await vm.upload(new File(["x"], "bad.wav"));
        expect(client.uploadContent).not.toHaveBeenCalled();
        vi.mocked(client.sendEvent).mockRejectedValue(new Error("offline"));
        await vm.play(builtin);
        expect(vm.getSnapshot().busy).toBe(false);
        expect(vm.getSnapshot().error).toBeTruthy();
    });
    it.each(["offline", "aborted"])(
        "retains the source and selection after an %s upload and cancels cleanly",
        async (failure) => {
            const file = new File(["audio"], "long.wav", { type: "audio/wav" });
            const preview = vi.fn().mockImplementation(async (start, end, update) => update(start, true));
            const dispose = vi.fn();
            const exportClip = vi.fn().mockReturnValue(file);
            vi.spyOn(SoundboardClip, "load").mockResolvedValue({
                name: file.name,
                duration: 25,
                waveform: () => [0.5, 1],
                preview,
                stop: vi.fn(),
                dispose,
                export: exportClip,
            } as unknown as SoundboardClip);
            vi.spyOn(SoundboardAudio, "duration").mockResolvedValue(8);
            vm.setUploadLibrary(space.roomId);
            await vm.upload(file);
            expect(vm.getSnapshot().clip).toMatchObject({ start: 0, end: 10 });
            expect(client.uploadContent).not.toHaveBeenCalled();
            vm.setClipRange(12, 20);
            await vm.previewClip();
            expect(preview).toHaveBeenCalledWith(12, 20, expect.any(Function), 100);
            expect(vm.getSnapshot().clip?.playing).toBe(true);
            vm.setClipRange(13, 21);
            expect(vm.getSnapshot().clip?.playing).toBe(false);
            vi.mocked(client.uploadContent).mockRejectedValueOnce(
                failure === "aborted" ? new DOMException("Request aborted", "AbortError") : new Error("offline"),
            );
            await vm.saveClip();
            expect(exportClip).toHaveBeenCalledWith(13, 21, 100);
            expect(vm.getSnapshot().clip).toMatchObject({ start: 13, end: 21 });
            expect(vm.getSnapshot().error).toBe(
                "Could not upload this sound. Check your connection and library permissions, then try again.",
            );
            vm.setClipRange(15, 99);
            expect(vm.getSnapshot().clip).toMatchObject({ start: 15, end: 25 });
            vm.cancelClip();
            expect(vm.getSnapshot().clip).toBeUndefined();
            expect(dispose).toHaveBeenCalledOnce();
            expect(client.sendStateEvent).not.toHaveBeenCalled();
        },
    );
    it("edits metadata in place without reuploading unchanged audio", async () => {
        const dispose = vi.fn();
        vi.spyOn(SoundboardClip, "loadStored").mockResolvedValue({
            name: "Hello",
            duration: 1.5,
            waveform: () => [0.5, 1],
            stop: vi.fn(),
            dispose,
        } as unknown as SoundboardClip);
        await vm.edit({ id: "hello", libraryId: space.roomId, name: "Hello", emoji: "👋" });
        expect(vm.getSnapshot()).toMatchObject({
            uploadLibraryId: space.roomId,
            uploadName: "Hello",
            uploadEmoji: "👋",
            clip: { editing: true, start: 0, end: 1.5, volume: 100 },
        });
        vm.setUploadName("Hello again");
        vm.setUploadEmoji("🦆");
        await vm.saveClip();
        expect(client.uploadContent).not.toHaveBeenCalled();
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            space.roomId,
            SOUNDBOARD_EVENT,
            { ...sound, name: "Hello again", emoji: "🦆" },
            "hello",
        );
        expect(dispose).toHaveBeenCalledOnce();
    });
    it("uploads replacement audio even when its full range and volume are unchanged", async () => {
        const file = new File(["replacement"], "replacement.wav", { type: "audio/wav" });
        const exportClip = vi.fn().mockReturnValue(file);
        const clip = {
            name: "replacement.wav",
            duration: 1.5,
            waveform: () => [1],
            stop: vi.fn(),
            dispose: vi.fn(),
            export: exportClip,
        } as unknown as SoundboardClip;
        vi.spyOn(SoundboardClip, "loadStored").mockResolvedValue(clip);
        vi.spyOn(SoundboardClip, "load").mockResolvedValue(clip);
        vi.spyOn(SoundboardAudio, "duration").mockResolvedValue(1.5);
        vi.mocked(client.uploadContent).mockResolvedValue({ content_uri: "mxc://example.org/replacement" });
        await vm.edit({ id: "hello", libraryId: space.roomId, name: "Hello", emoji: "👋" });
        await vm.upload(file);
        await vm.saveClip();
        expect(exportClip).toHaveBeenCalledWith(0, 1.5, 100);
        expect(client.uploadContent).toHaveBeenCalledWith(file);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            space.roomId,
            SOUNDBOARD_EVENT,
            { ...sound, url: "mxc://example.org/replacement" },
            "hello",
        );
    });
    it("saves trimmed audio and volume to the same sound ID and refuses changed entries", async () => {
        const file = new File(["new audio"], "hello.wav", { type: "audio/wav" });
        const exportClip = vi.fn().mockReturnValue(file);
        vi.spyOn(SoundboardClip, "loadStored").mockResolvedValue({
            name: "Hello",
            duration: 1.5,
            waveform: () => [0.5, 1],
            stop: vi.fn(),
            dispose: vi.fn(),
            export: exportClip,
        } as unknown as SoundboardClip);
        vi.spyOn(SoundboardAudio, "duration").mockResolvedValue(1);
        vi.mocked(client.uploadContent).mockResolvedValue({ content_uri: "mxc://example.org/edited" });
        const entry = { id: "hello", libraryId: space.roomId, name: "Hello", emoji: "👋" };
        await vm.edit(entry);
        vm.setClipRange(0.5, 1.5);
        vm.setClipVolume(50);
        await vm.saveClip();
        expect(exportClip).toHaveBeenCalledWith(0.5, 1.5, 50);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            space.roomId,
            SOUNDBOARD_EVENT,
            { ...sound, duration_ms: 1000, url: "mxc://example.org/edited" },
            "hello",
        );
        vi.mocked(client.sendStateEvent).mockClear();
        await vm.edit(entry);
        space.currentState.setStateEvents([
            new MatrixEvent({
                room_id: space.roomId,
                type: SOUNDBOARD_EVENT,
                state_key: "hello",
                content: { ...sound, name: "Someone else changed this" },
            }),
        ]);
        await vm.saveClip();
        expect(client.sendStateEvent).not.toHaveBeenCalled();
        expect(vm.getSnapshot().error).toBeTruthy();
        vm.cancelClip();
        expect(vm.getSnapshot().clip).toBeUndefined();
    });
    it("shares a single listener between toolbar owners and cleans it up after the final owner leaves", () => {
        const first = SoundboardViewModel.acquire({ client, call, spaceStore });
        const second = SoundboardViewModel.acquire({ client, call, spaceStore });
        expect(first.vm).toBe(second.vm);
        first.release();
        expect(first.vm.isDisposed).toBe(false);
        second.release();
        expect(first.vm.isDisposed).toBe(true);
        first.release();
    });
});
