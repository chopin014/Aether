/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
// The membership manager is not exported by the SDK, and this test covers our patch to it.
// oxlint-disable-next-line no-restricted-imports
import { MembershipManager } from "matrix-js-sdk/src/matrixrtc/MembershipManager";

const JOIN_ID = "io.aether.join_id";

/** A client that accepts every membership and delayed event request. */
function fakeClient(): ConstructorParameters<typeof MembershipManager>[2] & {
    sendStateEvent: ReturnType<typeof vi.fn>;
} {
    return {
        getUserId: () => "@alice:example.org",
        getDeviceId: () => "DEVICE",
        sendStateEvent: vi.fn().mockResolvedValue({ event_id: "$membership" }),
        _unstable_sendDelayedStateEvent: vi.fn().mockResolvedValue({ delay_id: "delay" }),
        _unstable_updateDelayedEvent: vi.fn().mockResolvedValue({}),
        _unstable_cancelScheduledDelayedEvent: vi.fn().mockResolvedValue({}),
        _unstable_restartScheduledDelayedEvent: vi.fn().mockResolvedValue({}),
        _unstable_sendScheduledDelayedEvent: vi.fn().mockResolvedValue({}),
    } as unknown as ConstructorParameters<typeof MembershipManager>[2] & { sendStateEvent: ReturnType<typeof vi.fn> };
}

describe("MatrixRTC membership re-join", () => {
    let manager: MembershipManager | undefined;
    afterEach(async () => {
        await manager?.leave(0);
        manager = undefined;
    });

    it("sends a new membership event when re-joining after our membership expired locally", async () => {
        const client = fakeClient();
        manager = new MembershipManager(undefined, { roomId: "!call:example.org", getVersion: () => "11" }, client, {
            application: "m.call",
            id: "ROOM",
        });
        manager.join([{ type: "livekit", livekit_service_url: "https://sfu.example.org" }]);
        await vi.waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));

        // Our membership no longer counts, as happens when our clock runs ahead or a renewal is late.
        await manager.onRTCSessionMemberUpdate([]);
        await vi.waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(2));

        const [first, second] = client.sendStateEvent.mock.calls.map((call) => call[2] as Record<string, unknown>);
        // The homeserver keeps the old event when the content is identical, so the re-join must differ.
        expect(first[JOIN_ID]).toEqual(expect.any(String));
        expect(second[JOIN_ID]).toEqual(expect.any(String));
        expect(second[JOIN_ID]).not.toBe(first[JOIN_ID]);
        expect({ ...second, [JOIN_ID]: null }).toEqual({ ...first, [JOIN_ID]: null });
    });

    it("keeps the join id when a join event is sent again after a timeout, as its hello announced it", async () => {
        const client = fakeClient();
        const timeout = Object.assign(new Error("timed out"), { name: "AbortError" });
        client.sendStateEvent.mockRejectedValueOnce(timeout);
        manager = new MembershipManager(undefined, { roomId: "!call:example.org", getVersion: () => "11" }, client, {
            application: "m.call",
            id: "ROOM",
        });
        manager.join([{ type: "livekit", livekit_service_url: "https://sfu.example.org" }]);
        await vi.waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(2));
        const [first, second] = client.sendStateEvent.mock.calls.map((call) => call[2] as Record<string, unknown>);
        expect(second[JOIN_ID]).toBe(first[JOIN_ID]);
        expect(manager.aetherCurrentJoinId).toBe(first[JOIN_ID]);
    });

    it("keeps the join id while the membership goes on, so that the others do not take it for a new join", async () => {
        const client = fakeClient();
        // Renewals fall due at once: the headroom exceeds the expiry.
        manager = new MembershipManager(
            { membershipEventExpiryMs: 1000, membershipEventExpiryHeadroomMs: 10_000 },
            { roomId: "!call:example.org", getVersion: () => "11" },
            client,
            { application: "m.call", id: "ROOM" },
        );
        manager.join([{ type: "livekit", livekit_service_url: "https://sfu.example.org" }]);
        await vi.waitFor(() => expect(client.sendStateEvent).toHaveBeenCalled());
        const ownMembership = {
            sender: "@alice:example.org",
            deviceId: "DEVICE",
            createdTs: () => 1,
        } as unknown as Parameters<MembershipManager["onRTCSessionMemberUpdate"]>[0][number];
        await manager.onRTCSessionMemberUpdate([ownMembership]);
        await vi.waitFor(() => expect(client.sendStateEvent.mock.calls.length).toBeGreaterThanOrEqual(3));
        // A change of the membership's data is sent as a join event of the same membership.
        await manager.updateApplicationData({ "io.example": 1 });

        const sent = client.sendStateEvent.mock.calls.map((call) => call[2] as Record<string, unknown>);
        expect(sent.at(-1)!["io.example"]).toBe(1);
        expect(new Set(sent.map((content) => content[JOIN_ID]))).toEqual(new Set([sent[0][JOIN_ID]]));
    });
});
