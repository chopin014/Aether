/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

/* oxlint-disable no-restricted-imports -- Exercise the patched SDK key manager, which has no public entry point. */
import { type CallMembership } from "matrix-js-sdk/src/matrixrtc/CallMembership";
import { RTCEncryptionManager } from "matrix-js-sdk/src/matrixrtc/RTCEncryptionManager";
import {
    type IKeyTransport,
    KeyTransportEvents,
    type KeyTransportEventsHandlerMap,
} from "matrix-js-sdk/src/matrixrtc/IKeyTransport";
/* oxlint-enable no-restricted-imports */

const own = { userId: "@alice:example.org", deviceId: "ALICE", memberId: "@alice:example.org:ALICE" };

function member(userId: string, deviceId: string): CallMembership {
    // Only identity and creation time take part in key distribution.
    const memberId = `${userId}:${deviceId}`;
    return {
        userId,
        deviceId,
        sender: userId,
        memberId,
        backendIdentities: [memberId],
        createdTs: () => 1,
    } as CallMembership;
}

describe("our MatrixRTC media key at join", () => {
    const managers: RTCEncryptionManager[] = [];

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        for (const manager of managers.splice(0)) manager.leave();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    function join(memberships: CallMembership[]) {
        const transport = Object.assign(new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>(), {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey: vi.fn<IKeyTransport["sendKey"]>(async () => {}),
        }) satisfies IKeyTransport;
        const manager = new RTCEncryptionManager(own, () => memberships, transport, vi.fn());
        managers.push(manager);
        manager.join({ manageMediaKeys: true, useKeyDelay: 0 }, []);
        const targets = (call: number): string[] =>
            transport.sendKey.mock.calls[call]![2].map(({ userId, deviceId }) => `${userId}|${deviceId}`);
        return { manager, transport, targets };
    }

    it("is made and sent to the members already in the call when joining, before our membership is known", async () => {
        const { transport, targets } = join([member("@bob:example.org", "BOB")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.sendKey).toHaveBeenCalledOnce();
        expect(transport.sendKey.mock.calls[0]![1]).toBe(0);
        expect(targets(0)).toEqual(["@bob:example.org|BOB"]);
    });

    it("is sent again, unchanged, once our membership is known, and our own late membership causes no rotation", async () => {
        const memberships = [member("@bob:example.org", "BOB")];
        const { manager, transport, targets } = join(memberships);
        await vi.advanceTimersByTimeAsync(0);
        const firstKey = transport.sendKey.mock.calls[0]![0];
        // Our membership comes back over sync long after the rotation grace period.
        await vi.advanceTimersByTimeAsync(30_000);
        memberships.push(member(own.userId, own.deviceId));
        manager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.sendKey).toHaveBeenCalledTimes(2);
        expect(transport.sendKey.mock.calls[1]![0]).toBe(firstKey);
        expect(transport.sendKey.mock.calls[1]![1]).toBe(0);
        expect(targets(1)).toEqual(["@bob:example.org|BOB"]);
        // Nothing further once everyone has it.
        manager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.sendKey).toHaveBeenCalledTimes(2);
    });

    it("still rotates for someone who leaves", async () => {
        const memberships = [member("@bob:example.org", "BOB"), member("@carol:example.org", "CAROL")];
        const { manager, transport } = join(memberships);
        await vi.advanceTimersByTimeAsync(0);
        memberships.push(member(own.userId, own.deviceId));
        manager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(0);
        memberships.splice(1, 1);
        manager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.sendKey.mock.lastCall![1]).toBe(1);
    });
});
