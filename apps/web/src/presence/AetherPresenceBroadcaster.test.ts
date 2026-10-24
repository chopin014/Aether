/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetPresence } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { AetherPresenceBroadcaster } from "./AetherPresenceBroadcaster";
import { AETHER_PRESENCE_EVENT_TYPE, HEARTBEAT_MS, PRESENCE_TTL_MS } from "./aetherPresence";
import { makeFakeClient, makeFakeCrypto, type FakeCrypto } from "../test/test-utils/aetherPresence";

const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
};

describe("AetherPresenceBroadcaster", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        vi.spyOn(logger, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const setup = (crypto: FakeCrypto | null = makeFakeCrypto()) => {
        const client = makeFakeClient({
            crypto,
            rooms: [{ id: "!r", members: ["@me:example.org", "@bob:example.org", "@carol:example.org"] }],
        });
        return { client, crypto, broadcaster: new AetherPresenceBroadcaster(client) };
    };

    it("sends one encrypted batch to every recipient device on start", async () => {
        const { client, crypto, broadcaster } = setup(makeFakeCrypto({ "@bob:example.org": ["A", "B"] }));
        broadcaster.start(SetPresence.Online);
        await flush();
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(1);
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(1);
        const [type, devices, content] = crypto!.encryptToDeviceMessages.mock.calls[0];
        expect(type).toBe(AETHER_PRESENCE_EVENT_TYPE);
        expect(devices).toEqual([
            { userId: "@bob:example.org", deviceId: "A" },
            { userId: "@bob:example.org", deviceId: "B" },
            { userId: "@carol:example.org", deviceId: "DEV" },
        ]);
        expect(content).toEqual({
            v: 1,
            presence: "online",
            ttl_ms: PRESENCE_TTL_MS,
            ts: 1_700_000_000_000,
        });
        // One queued batch, not one request per user.
        expect(client.queueToDevice).toHaveBeenCalledTimes(1);
        expect(vi.mocked(client.queueToDevice).mock.calls[0][0].eventType).toBe("m.room.encrypted");
    });

    it("never sends in plaintext when crypto is unavailable", async () => {
        const { client, broadcaster } = setup(null);
        broadcaster.start(SetPresence.Online);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
        expect(client.queueToDevice).not.toHaveBeenCalled();
    });

    it("repeats the status on the heartbeat", async () => {
        const { client, broadcaster } = setup();
        broadcaster.start(SetPresence.Online);
        await flush();
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1000);
        expect(client.queueToDevice).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(client.queueToDevice).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
        expect(client.queueToDevice).toHaveBeenCalledTimes(3);
    });

    it("sends immediately when the preference changes", async () => {
        const { crypto, broadcaster } = setup();
        broadcaster.start(SetPresence.Online);
        await flush();
        broadcaster.setPresence(SetPresence.Unavailable);
        await flush();
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(2);
        expect(crypto!.encryptToDeviceMessages.mock.calls[1][2]).toMatchObject({ presence: "unavailable" });
    });

    it("sends offline once for Invisible and then stays quiet", async () => {
        const { crypto, broadcaster } = setup();
        broadcaster.start(SetPresence.Online);
        await flush();
        broadcaster.setPresence(SetPresence.Offline);
        await flush();
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(2);
        expect(crypto!.encryptToDeviceMessages.mock.calls[1][2]).toMatchObject({ presence: "offline" });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5);
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(2);

        broadcaster.setPresence(SetPresence.Online);
        await flush();
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(3);
        expect(crypto!.encryptToDeviceMessages.mock.calls[2][2]).toMatchObject({ presence: "online" });
    });

    it("starts silent apart from one offline when the saved choice is Invisible", async () => {
        const { crypto, broadcaster } = setup();
        broadcaster.start(SetPresence.Offline);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(1);
        expect(crypto!.encryptToDeviceMessages.mock.calls[0][2]).toMatchObject({ presence: "offline" });
    });

    it("backs off after failures instead of retrying at once, and recovers", async () => {
        const { client, crypto, broadcaster } = setup();
        crypto!.getUserDeviceInfo.mockRejectedValueOnce(new Error("boom")).mockRejectedValueOnce(new Error("boom"));
        broadcaster.start(SetPresence.Online);
        await flush();
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_500); // 30s
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1_500); // then 60s
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(3);
        expect(client.queueToDevice).toHaveBeenCalledTimes(1);
    });

    it("honours a rate limit's retry_after_ms, capped at the heartbeat", async () => {
        const { crypto, broadcaster } = setup();
        crypto!.getUserDeviceInfo.mockRejectedValueOnce(
            Object.assign(new Error("429"), { data: { retry_after_ms: 120_000 } }),
        );
        broadcaster.start(SetPresence.Online);
        await flush();
        await vi.advanceTimersByTimeAsync(119_000);
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_500);
        expect(crypto!.getUserDeviceInfo).toHaveBeenCalledTimes(2);
    });

    it("sends a best-effort offline and clears its timers on stop", async () => {
        const { crypto, broadcaster } = setup();
        broadcaster.start(SetPresence.Online);
        await flush();
        broadcaster.stop();
        await flush();
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(2);
        expect(crypto!.encryptToDeviceMessages.mock.calls[1][2]).toMatchObject({ presence: "offline" });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(2);
    });

    it("does not repeat offline on stop when Invisible already sent it", async () => {
        const { crypto, broadcaster } = setup();
        broadcaster.start(SetPresence.Offline);
        await flush();
        broadcaster.stop();
        await flush();
        expect(crypto!.encryptToDeviceMessages).toHaveBeenCalledTimes(1);
    });

    it("skips devices that are dehydrated", async () => {
        const { crypto, broadcaster } = setup();
        crypto!.getUserDeviceInfo.mockResolvedValueOnce(
            new Map([["@bob:example.org", new Map([["D", { deviceId: "D", dehydrated: true }]])]]),
        );
        broadcaster.start(SetPresence.Online);
        await flush();
        expect(crypto!.encryptToDeviceMessages).not.toHaveBeenCalled();
    });
});
