/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, type MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { getMockClientWithEventEmitter } from "test-utils";

import { waitForRoom } from "./waitForRoom";

describe("waitForRoom", () => {
    afterEach(() => vi.useRealTimers());

    const makeClient = (): MatrixClient => getMockClientWithEventEmitter({ getRoom: vi.fn().mockReturnValue(null) });

    it("resolves at once with a room that is already ready", async () => {
        const client = makeClient();
        const room = new Room("!a:x", client, "@me:x");
        vi.mocked(client.getRoom).mockReturnValue(room);
        await expect(waitForRoom(client, "!a:x", () => true)).resolves.toBe(room);
    });

    it("waits for sync to deliver the room and stops listening", async () => {
        const client = makeClient();
        const room = new Room("!a:x", client, "@me:x");
        const waiting = waitForRoom(client, "!a:x", () => true);
        vi.mocked(client.getRoom).mockReturnValue(room);
        client.emit(ClientEvent.Room, room);
        await expect(waiting).resolves.toBe(room);
        expect(client.listenerCount(ClientEvent.Room)).toBe(0);
    });

    it("gives up after the timeout", async () => {
        vi.useFakeTimers();
        const client = makeClient();
        const waiting = waitForRoom(client, "!a:x", () => true, 1000);
        vi.advanceTimersByTime(1000);
        await expect(waiting).resolves.toBeNull();
        expect(client.listenerCount(ClientEvent.Room)).toBe(0);
    });
});
