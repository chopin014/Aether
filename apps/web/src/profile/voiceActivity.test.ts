/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { CallStore, CallStoreEvent } from "../stores/CallStore";
import { CallEvent } from "../models/Call";
import { SDKContextClass } from "../contexts/SDKContextClass";
import { VoiceActivityIndex, voiceActivity } from "./voiceActivity";

vi.mock("../customisations/Media", () => ({
    mediaFromMxc: (mxc: string) => ({ getThumbnailOfSourceHttp: () => `http://thumb/${mxc}` }),
}));

/** Just enough of an event emitter for the index to listen to. */
class Emitter {
    private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    public on(event: string, handler: (...args: unknown[]) => void): void {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event)!.add(handler);
    }
    public off(event: string, handler: (...args: unknown[]) => void): void {
        this.handlers.get(event)?.delete(handler);
    }
    public emit(event: string, ...args: unknown[]): void {
        for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
}

/** A call in a room, with people in it. */
class FakeCall extends Emitter {
    public participants = new Map<unknown, Set<string>>();
    public constructor(public readonly roomId: string) {
        super();
    }
    public setPeople(...userIds: string[]): void {
        this.participants = new Map(
            userIds.map((userId) => [
                { userId, name: userId.slice(1, 4), getMxcAvatarUrl: () => `mxc://example.org/${userId.slice(1, 4)}` },
                new Set(["DEVICE"]),
            ]),
        );
        this.emit(CallEvent.Participants);
    }
}

class FakeCallStore extends Emitter {
    public calls = new Map<string, FakeCall>();
    public getAllCalls(): Map<string, FakeCall> {
        return this.calls;
    }
    public getCall(roomId: string): FakeCall | null {
        return this.calls.get(roomId) ?? null;
    }
    public add(call: FakeCall): void {
        this.calls.set(call.roomId, call);
        this.emit(CallStoreEvent.Call, call, call.roomId);
    }
}

describe("VoiceActivityIndex", () => {
    afterEach(() => vi.restoreAllMocks());

    it("knows who is in which voice channel and tells subscribers when that changes", () => {
        const store = new FakeCallStore();
        const index = new VoiceActivityIndex(store as unknown as CallStore);
        const listener = vi.fn();
        index.subscribe(listener);

        const lounge = new FakeCall("!lounge:example.org");
        store.add(lounge);
        expect(listener).not.toHaveBeenCalled();
        lounge.setPeople("@robin:example.org", "@sam:example.org");
        expect(index.roomOf("@robin:example.org")).toBe("!lounge:example.org");
        expect(listener).toHaveBeenCalledTimes(1);

        lounge.setPeople("@sam:example.org");
        expect(index.roomOf("@robin:example.org")).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(2);

        // Nothing changed for anyone, so nobody is woken up.
        lounge.setPeople("@sam:example.org");
        expect(listener).toHaveBeenCalledTimes(2);

        index.dispose();
        lounge.setPeople("@robin:example.org");
        expect(index.roomOf("@robin:example.org")).toBe(undefined);
    });

    it("forgets everyone when the store destroys its calls, as it does when the client stops", async () => {
        const store = new FakeCallStore();
        const lounge = new FakeCall("!lounge:example.org");
        store.add(lounge);
        const index = new VoiceActivityIndex(store as unknown as CallStore);
        lounge.setPeople("@robin:example.org");
        const listener = vi.fn();
        index.subscribe(listener);

        // The store tears calls down while they are still listed, then empties the list without saying so.
        lounge.emit(CallEvent.Destroy);
        store.calls.clear();
        await Promise.resolve();
        expect(index.roomOf("@robin:example.org")).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(1);
        // A destroyed call is no longer listened to.
        lounge.setPeople("@robin:example.org");
        expect(index.roomOf("@robin:example.org")).toBeUndefined();

        // A new session's calls are picked up as usual.
        const next = new FakeCall("!lounge:example.org");
        store.add(next);
        next.setPeople("@robin:example.org");
        expect(index.roomOf("@robin:example.org")).toBe("!lounge:example.org");
    });

    it("describes the channel for a profile card, with its Space and the first faces", () => {
        const store = new FakeCallStore();
        const call = new FakeCall("!lounge:example.org");
        call.setPeople("@robin:example.org", "@sam:example.org");
        store.calls.set(call.roomId, call);
        vi.spyOn(CallStore, "instance", "get").mockReturnValue(store as unknown as CallStore);
        vi.spyOn(SDKContextClass.instance, "spaceStore", "get").mockReturnValue({
            getParents: () => [{ name: "Aether HQ" }],
        } as unknown as SDKContextClass["spaceStore"]);
        const client = { getRoom: (id: string) => (id === call.roomId ? { name: "Lounge" } : null) } as MatrixClient;

        expect(voiceActivity(client, undefined)).toBeUndefined();
        expect(voiceActivity(client, "!elsewhere:example.org")).toBeUndefined();
        expect(voiceActivity(client, call.roomId)).toEqual({
            kind: "voice",
            roomId: "!lounge:example.org",
            channelName: "Lounge",
            spaceName: "Aether HQ",
            count: 2,
            people: [
                { id: "@robin:example.org", name: "rob", avatarUrl: "http://thumb/mxc://example.org/rob" },
                { id: "@sam:example.org", name: "sam", avatarUrl: "http://thumb/mxc://example.org/sam" },
            ],
        });
    });
});
