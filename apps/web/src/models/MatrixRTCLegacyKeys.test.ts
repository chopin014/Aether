/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64, TypedEventEmitter } from "matrix-js-sdk/src/matrix";

/* oxlint-disable no-restricted-imports -- Exercise the patched SDK key manager, which has no public entry point. */
import { type CallMembership } from "matrix-js-sdk/src/matrixrtc/CallMembership";
import { RTCEncryptionManager } from "matrix-js-sdk/src/matrixrtc/RTCEncryptionManager";
import {
    type IKeyTransport,
    KeyTransportEvents,
    type KeyTransportEventsHandlerMap,
} from "matrix-js-sdk/src/matrixrtc/IKeyTransport";
/* oxlint-enable no-restricted-imports */

const userId = "@bob:example.org";
const deviceId = "BOB";
const legacyIdentity = `${userId}:${deviceId}`;
const key = new Uint8Array(16).fill(7);

function member(memberId = legacyIdentity, backendIdentities = [legacyIdentity]): CallMembership {
    // Only identity and creation time participate in key matching/distribution.
    return { userId, deviceId, sender: userId, memberId, backendIdentities, createdTs: () => 1 } as CallMembership;
}

describe("MatrixRTC keys from existing Element Call clients", () => {
    const managers: RTCEncryptionManager[] = [];

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        for (const manager of managers.splice(0)) manager.leave();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    function setup(memberships: CallMembership[]) {
        const onKey = vi.fn();
        const transport = Object.assign(new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>(), {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey: vi.fn(async () => {}),
        }) satisfies IKeyTransport;
        const manager = new RTCEncryptionManager(
            { userId: "@alice:example.org", deviceId: "ALICE", memberId: "alice-session" },
            () => memberships,
            transport,
            onKey,
        );
        managers.push(manager);
        manager.join({ manageMediaKeys: true, useKeyDelay: 0 }, []);
        const receive = (parts = { userId, deviceId, memberId: "existing-client-join-uuid" }, index = 0): void => {
            transport.emit(KeyTransportEvents.ReceivedKeys, parts, encodeBase64(key), index, Date.now());
        };
        return { manager, onKey, receive };
    }

    it("binds a per-join key ID to the same legacy user/device backend identity", () => {
        const { onKey, receive } = setup([member()]);
        receive();
        expect(onKey).toHaveBeenCalledWith(key, 0, expect.objectContaining({ userId, deviceId }), legacyIdentity);
    });

    it("continues applying rotated keys", () => {
        const { onKey, receive } = setup([member()]);
        receive(undefined, 10);
        receive(undefined, 11);
        expect(onKey).toHaveBeenCalledTimes(2);
        expect(onKey).toHaveBeenLastCalledWith(key, 11, expect.anything(), legacyIdentity);
    });

    it.each([
        { userId: "@mallory:example.org", deviceId, memberId: "other" },
        { userId, deviceId: "OTHER_DEVICE", memberId: "other" },
    ])("does not accept a key for another user or device: %j", (parts) => {
        const { onKey, receive } = setup([member()]);
        receive(parts);
        expect(onKey).not.toHaveBeenCalled();
    });

    it.each([
        member("current-session", ["hashed-backend-identity"]),
        member(legacyIdentity, [legacyIdentity, "hashed-backend-identity"]),
        member(legacyIdentity, []),
    ])("retains exact membership ID matching for modern or ambiguous backends", (membership) => {
        const { onKey, receive } = setup([membership]);
        receive();
        expect(onKey).not.toHaveBeenCalled();
    });

    it("accepts an exact current membership ID", () => {
        const { onKey, receive } = setup([member("current-session", ["hashed-backend-identity"])]);
        receive({ userId, deviceId, memberId: "current-session" });
        expect(onKey).toHaveBeenCalledWith(key, 0, expect.anything(), "hashed-backend-identity");
    });

    it("defers keys until the matching legacy membership arrives", () => {
        const memberships: CallMembership[] = [];
        const { manager, onKey, receive } = setup(memberships);
        receive();
        expect(onKey).not.toHaveBeenCalled();
        memberships.push(member());
        manager.onMembershipsUpdate();
        expect(onKey).toHaveBeenCalledWith(key, 0, expect.anything(), legacyIdentity);
    });
});
