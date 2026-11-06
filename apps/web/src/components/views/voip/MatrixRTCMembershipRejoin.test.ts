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
});
