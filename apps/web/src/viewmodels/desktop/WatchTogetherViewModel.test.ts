/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

// oxlint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { WatchTogetherViewModel } from "./WatchTogetherViewModel";
import { CallEvent, type ElementCall } from "../../models/Call";
import SettingsStore from "../../settings/SettingsStore";
import type { SoundboardTransport } from "../../audio/soundboard/SoundboardTransport";
import type { WatchPlayer, WatchPlayerEvent, WatchPlayerStatus } from "../../activities/watch-together/WatchPlayer";
import {
    encodeMessage,
    parseMessage,
    WATCH_STATE,
    type WatchState,
} from "../../activities/watch-together/WatchTogetherProtocol";

class StubPlayer implements WatchPlayer {
    public readonly element = document.createElement("div");
    public itemId: string | null = null;
    public volume = 1;
    public statusValue: Partial<WatchPlayerStatus> = {};
    public constructor(public readonly source: "youtube" | "media") {}
    public load(item: { id: string }): void {
        this.itemId = item.id;
    }
    public play(): void {}
    public pause(): void {}
    public seek(): void {}
    public setRate(): void {}
    public setVolume(volume: number): void {
        this.volume = volume;
    }
    public status(): WatchPlayerStatus {
        return {
            ready: true,
            playing: true,
            buffering: false,
            time: 12,
            duration: 300,
            rate: 1,
            hasVideo: true,
            ...this.statusValue,
        };
    }
    public subscribe(_listener: (event: WatchPlayerEvent) => void): () => void {
        return () => {};
    }
    public dispose(): void {}
}

describe("WatchTogetherViewModel", () => {
    let client: MatrixClient;
    let call: ElementCall;
    let vm: WatchTogetherViewModel;
    let sent: Uint8Array[];
    let receive: (payload: Uint8Array, sender: string) => void;
    let players: StubPlayer[];
    let deafened: boolean;
    let deafenWatcher: () => void;

    const transport = (): SoundboardTransport => ({
        send: async (payload) => {
            sent.push(payload);
        },
        subscribe: (listener) => {
            receive = listener;
            return () => {};
        },
    });
    const lastState = (): WatchState => {
        const states = sent.map(parseMessage).filter((m) => m?.type === WATCH_STATE);
        return (states.at(-1) as { state: WatchState }).state;
    };
    /** Bob's change on top of the newest state anyone sent, as his client would make it. */
    let latestRemote: WatchState | undefined;
    const remote = (patch: Partial<WatchState>): void => {
        const base = latestRemote && latestRemote.revision > lastState().revision ? latestRemote : lastState();
        latestRemote = { ...base, ...patch, revision: base.revision + 1, author: "@bob:example.org", origin: "zzz" };
        receive(encodeMessage({ type: WATCH_STATE, state: latestRemote }), "@bob:example.org");
    };

    beforeEach(() => {
        latestRemote = undefined;
        localStorage.clear();
        sent = [];
        players = [];
        deafened = false;
        client = stubClient();
        vi.mocked(client.getRoom).mockReturnValue({
            getMember: (userId: string) => ({ rawDisplayName: userId === "@bob:example.org" ? "Bob" : "Me" }),
        } as never);
        call = Object.assign(new EventEmitter(), {
            roomId: "!voice:example.org",
            soundboardTransport: transport(),
        }) as unknown as ElementCall;
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "desktopDeafened" ? deafened : undefined) as never);
        vi.spyOn(SettingsStore, "watchSetting").mockImplementation(((_: string, __: unknown, cb: () => void) => {
            deafenWatcher = cb;
            return "watch";
        }) as never);
        vi.spyOn(SettingsStore, "unwatchSetting").mockImplementation(() => {});
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ title: "Big Buck Bunny", author_name: "Blender" }), { status: 200 }),
        );
        vm = new WatchTogetherViewModel({
            client,
            call,
            createPlayer: (source) => {
                const player = new StubPlayer(source);
                players.push(player);
                return player;
            },
        });
    });

    afterEach(() => {
        vm.dispose();
        vi.restoreAllMocks();
    });

    it("plays a pasted YouTube link for everyone, with its title", async () => {
        expect(vm.getSnapshot()).toMatchObject({ connected: true, active: false });
        expect(vm.addLink("https://youtu.be/aqz-KE-bpKQ")).toBe(true);
        await vi.waitFor(() => expect(vm.getSnapshot().active).toBe(true));
        expect(lastState().items[0]).toMatchObject({
            source: "youtube",
            ref: "aqz-KE-bpKQ",
            title: "Big Buck Bunny",
            channel: "Blender",
            addedBy: client.getSafeUserId(),
        });
        expect(vm.getSnapshot()).toMatchObject({
            title: "Big Buck Bunny",
            subtitle: "Blender",
            sourceName: "YouTube",
            embedHandlesClicks: true,
            thumbnailUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg",
        });
    });

    it("ignores pasted text that is not a playable link", () => {
        expect(vm.addLink("hello there")).toBe(false);
        expect(sent.some((payload) => parseMessage(payload)?.type === WATCH_STATE)).toBe(false);
        expect(vm.getSnapshot().active).toBe(false);
    });

    it("queues from the panel once something is playing, and plays now on request", async () => {
        vm.setDraft("https://youtu.be/aqz-KE-bpKQ");
        await vm.submitDraft("play");
        expect(vm.getSnapshot().draft).toBe("");
        vm.setDraft("https://cdn.example.org/Song.mp3");
        await vm.submitDraft("queue");
        expect(vm.getSnapshot().queue.map((q) => q.title)).toEqual(["Big Buck Bunny", "Song"]);
        vm.setDraft("https://youtu.be/jNQXAC9IVRw");
        await vm.submitDraft("play");
        expect(vm.getSnapshot().queue.map((q) => q.current)).toEqual([false, true, false]);
    });

    it("explains why a link was refused", async () => {
        vm.setDraft("not a link");
        await vm.submitDraft("play");
        expect(vm.getSnapshot().addError).toBeTruthy();
        vi.mocked(fetch).mockResolvedValue(new Response("", { status: 401 }));
        vm.setDraft("https://youtu.be/aqz-KE-bpKQ");
        await vm.submitDraft("play");
        expect(vm.getSnapshot()).toMatchObject({ active: false, adding: false });
        expect(vm.getSnapshot().addError).toMatch(/owner/);
        vm.setDraft("https://youtu.be/aqz-KE-bpKQ");
        expect(vm.getSnapshot().addError).toBeUndefined();
    });

    it("does not share links after leaving the call", async () => {
        Object.assign(call, { soundboardTransport: null });
        call.emit(CallEvent.SoundboardTransport);
        expect(vm.getSnapshot().connected).toBe(false);
        expect(vm.addLink("https://youtu.be/aqz-KE-bpKQ")).toBe(false);
        vm.setDraft("https://youtu.be/aqz-KE-bpKQ");
        await vm.submitDraft("play");
        expect(vm.getSnapshot().addError).toMatch(/Join the call/);
    });

    it("says who did what when someone else changes the player", async () => {
        vm.addLink("https://youtu.be/aqz-KE-bpKQ");
        await vi.waitFor(() => expect(vm.getSnapshot().active).toBe(true));
        remote({ playing: false, position: 12 });
        expect(vm.getSnapshot().notice?.text).toBe("Bob paused");
        const first = vm.getSnapshot().notice!.id;
        remote({ rate: 1.5 });
        expect(vm.getSnapshot().notice).toEqual({ id: first + 1, text: "Bob set the speed to 1.5×" });
        remote({ items: [], index: -1 });
        expect(vm.getSnapshot()).toMatchObject({ active: false, notice: { text: "Bob ended the activity" } });
    });

    it("announces something someone else starts, but not the catch-up after joining late", () => {
        const item = {
            id: "i1",
            source: "youtube" as const,
            ref: "aqz-KE-bpKQ",
            title: "Bunny",
            addedBy: "@bob:example.org",
        };
        const started = {
            session: "s1",
            revision: 1,
            author: "@bob:example.org",
            origin: "zzz",
            items: [item],
            index: 0,
            playing: true,
            position: -1.2,
            rate: 1,
            ended: false,
        };
        receive(encodeMessage({ type: WATCH_STATE, state: started }), "@bob:example.org");
        expect(vm.getSnapshot().notice?.text).toBe("Bob started Bunny");

        const late = new WatchTogetherViewModel({
            client,
            call: Object.assign(new EventEmitter(), {
                roomId: call.roomId,
                soundboardTransport: transport(),
            }) as unknown as ElementCall,
        });
        receive(encodeMessage({ type: WATCH_STATE, state: { ...started, position: 300 } }), "@bob:example.org");
        expect(late.getSnapshot().active).toBe(true);
        expect(late.getSnapshot().notice).toBeUndefined();
        late.dispose();
    });

    it("keeps its own volume, and plays nothing while deafened", async () => {
        vm.addLink("https://youtu.be/aqz-KE-bpKQ");
        await vi.waitFor(() => expect(players).toHaveLength(1));
        vm.setVolume(40);
        expect(players[0].volume).toBeCloseTo(0.4);
        expect(localStorage.getItem("aether_watch_together_volume")).toBe("40");
        deafened = true;
        deafenWatcher();
        expect(players[0].volume).toBe(0);
        expect(vm.getSnapshot()).toMatchObject({ deafened: true, volume: 40 });
    });

    it("shows the player inside the host the view gives it", async () => {
        const host = document.createElement("div");
        vm.attachPlayer(host);
        vm.addLink("https://youtu.be/aqz-KE-bpKQ");
        await vi.waitFor(() => expect(host.firstChild).toBe(players[0].element));
        vm.stop();
        expect(host.childNodes).toHaveLength(0);
    });

    it("reports a video this device cannot play", async () => {
        vm.addLink("https://youtu.be/aqz-KE-bpKQ");
        await vi.waitFor(() => expect(players).toHaveLength(1));
        players[0].statusValue = { error: "not_embeddable" };
        vm.togglePlaying();
        expect(vm.getSnapshot().playerError).toMatch(/owner/);
    });

    it("is shared by every view of the call and disposed with the last one", () => {
        const first = WatchTogetherViewModel.acquire({ client, call });
        const second = WatchTogetherViewModel.acquire({ client, call });
        expect(second.vm).toBe(first.vm);
        const dispose = vi.spyOn(first.vm, "dispose");
        first.release();
        expect(dispose).not.toHaveBeenCalled();
        second.release();
        expect(dispose).toHaveBeenCalled();
    });
});
