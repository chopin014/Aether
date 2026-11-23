/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

/* oxlint-disable no-restricted-imports -- Exercise the patched SDK key manager, which has no public entry point. */
import { type CallMembership } from "matrix-js-sdk/src/matrixrtc/CallMembership";
import {
    MAX_JOIN_RATCHETS,
    ratchetMediaKey,
    RTCEncryptionManager,
} from "matrix-js-sdk/src/matrixrtc/RTCEncryptionManager";
import {
    type IKeyTransport,
    KeyTransportEvents,
    type KeyTransportEventsHandlerMap,
} from "matrix-js-sdk/src/matrixrtc/IKeyTransport";
import { decodeBase64 } from "matrix-js-sdk/src/base64";
/* oxlint-enable no-restricted-imports */

const own = { userId: "@alice:example.org", deviceId: "ALICE", memberId: "@alice:example.org:ALICE" };
const ownIdentity = "@alice:example.org:ALICE";

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

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** Lets timers and the Web Crypto work they wait for run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise((resolve) => setImmediate(resolve));
    }
}

describe("ratchetMediaKey", () => {
    it("derives the key LiveKit's E2EE worker ratchets to", async () => {
        // Computed with the `kn`/`Dn` ratchet functions of the LiveKit E2EE worker bundled in Element Call.
        const key = new Uint8Array(16).map((_, i) => i + 1);
        const once = await ratchetMediaKey(key);
        expect(hex(once)).toBe("fa52d6a9fd1f097b247b99d6805e1b1bf2fda95867a9ad051720410dd56f6bdc");
        expect(hex(await ratchetMediaKey(once))).toBe(
            "4d5b6446291f4d79cad07f0a48f903417c8ed0b7767df135e5d1ae8377007ddd",
        );
    });
});

describe("our MatrixRTC media key when someone joins", () => {
    const managers: RTCEncryptionManager[] = [];

    beforeEach(() =>
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }),
    );
    afterEach(() => {
        for (const manager of managers.splice(0)) manager.leave();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    /** Joins with `others` in the call, waits until our own membership is known and our key is a minute old. */
    async function inCall(others: CallMembership[]) {
        const memberships = [...others];
        const transport = Object.assign(new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>(), {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey: vi.fn<IKeyTransport["sendKey"]>(async () => {}),
        }) satisfies IKeyTransport;
        const keysChanged = vi.fn();
        const manager = new RTCEncryptionManager(own, () => memberships, transport, keysChanged);
        managers.push(manager);
        manager.join({ manageMediaKeys: true, useKeyDelay: 1000, keyRotationGracePeriodMs: 10_000 }, [
            { type: "livekit", livekit_service_url: "https://lk.example.org" },
        ]);
        await settle();
        memberships.push(member(own.userId, own.deviceId));
        manager.onMembershipsUpdate();
        await settle();
        await vi.advanceTimersByTimeAsync(60_000);
        await settle();
        const ownKeys = (): { key: Uint8Array; index: number }[] =>
            keysChanged.mock.calls
                .filter(([, , , identity]) => identity === ownIdentity)
                .map(([key, index]) => ({ key, index }));
        const sent = (call: number) => {
            const [key, index, targets] = transport.sendKey.mock.calls[call]!;
            return { key: decodeBase64(key), index, targets: targets.map(({ userId }) => userId) };
        };
        const join = async (userId: string): Promise<void> => {
            const sends = transport.sendKey.mock.calls.length;
            memberships.push(member(userId, userId.slice(1, 4).toUpperCase()));
            manager.onMembershipsUpdate();
            // Ratcheting runs on Web Crypto, which takes as long as it takes.
            await vi.waitFor(() => expect(transport.sendKey.mock.calls.length).toBeGreaterThan(sends));
            await settle();
        };
        return { manager, memberships, transport, ownKeys, sent, join };
    }

    it("gives joiners our key ratcheted once and uses it at once, without waiting for it to be delivered", async () => {
        const { transport, ownKeys, sent, join } = await inCall([member("@bob:example.org", "BOB")]);
        const before = ownKeys().at(-1)!;
        const calls = transport.sendKey.mock.calls.length;

        await join("@carol:example.org");

        expect(transport.sendKey).toHaveBeenCalledTimes(calls + 1);
        const toCarol = sent(calls);
        expect(toCarol.targets).toEqual(["@carol:example.org"]);
        expect(toCarol.index).toBe(before.index);
        expect(hex(toCarol.key)).toBe(hex(await ratchetMediaKey(before.key as Uint8Array<ArrayBuffer>)));
        // Already in use: no `useKeyDelay` wait.
        expect(hex(ownKeys().at(-1)!.key)).toBe(hex(toCarol.key));
        expect(ownKeys().at(-1)!.index).toBe(before.index);
    });

    it("never gives a joiner the key that encrypted the call before they came", async () => {
        const { transport, ownKeys, join } = await inCall([member("@bob:example.org", "BOB")]);
        const before = hex(ownKeys().at(-1)!.key);
        await join("@carol:example.org");
        const toCarol = transport.sendKey.mock.calls
            .filter(([, , targets]) => targets.some(({ userId }) => userId === "@carol:example.org"))
            .map(([key]) => hex(decodeBase64(key)));
        expect(toCarol).not.toContain(before);
    });

    it("replaces a key ratcheted too often with a new one for everyone, used after the delivery delay", async () => {
        const { transport, ownKeys, sent, join } = await inCall([member("@bob:example.org", "BOB")]);
        const index = ownKeys().at(-1)!.index;
        for (let i = 0; i < MAX_JOIN_RATCHETS; i++) await join(`@j${i}:example.org`);
        await vi.waitFor(() => expect(transport.sendKey.mock.lastCall![1]).toBe((index + 1) % 256));

        const rotation = sent(transport.sendKey.mock.calls.length - 1);
        expect(rotation.index).toBe((index + 1) % 256);
        expect(rotation.targets).toHaveLength(1 + MAX_JOIN_RATCHETS);
        // The ratcheted key stays in use until everyone could have the new one.
        expect(ownKeys().at(-1)!.index).toBe(index);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(ownKeys().at(-1)!.index).toBe(rotation.index));

        // Ratcheting starts again from the new key.
        const calls = transport.sendKey.mock.calls.length;
        await join("@late:example.org");
        expect(sent(calls).index).toBe(rotation.index);
        expect(hex(sent(calls).key)).toBe(hex(await ratchetMediaKey(rotation.key as Uint8Array<ArrayBuffer>)));
    });

    it("still rotates to a new key when someone leaves", async () => {
        const { manager, memberships, transport, ownKeys, sent } = await inCall([
            member("@bob:example.org", "BOB"),
            member("@carol:example.org", "CAROL"),
        ]);
        const index = ownKeys().at(-1)!.index;
        memberships.splice(1, 1);
        manager.onMembershipsUpdate();
        await settle();
        const rotation = sent(transport.sendKey.mock.calls.length - 1);
        expect(rotation.index).toBe((index + 1) % 256);
        expect(rotation.targets).toEqual(["@bob:example.org"]);
    });
});
