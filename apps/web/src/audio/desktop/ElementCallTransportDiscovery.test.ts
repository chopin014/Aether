/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const bundle = readFileSync(require.resolve("@element-hq/element-call-component"), "utf8");
const start = bundle.indexOf("//#region src/state/CallViewModel/localMember/RtcTransportAutoDiscovery.ts");
const end = bundle.indexOf("//#endregion", start);

function fixture(cached?: Promise<unknown[]>, hostServiceUrl?: (client: unknown) => Promise<string | undefined>) {
    const direct = vi.fn().mockResolvedValue([{ type: "livekit", livekit_service_url: "https://direct" }]);
    const wait = vi.fn().mockReturnValue(cached);
    const client = { _unstable_getRTCTransports: direct, cachedRtcTransports: cached ? { wait } : undefined };
    const logger = { getChild: () => logger, info: vi.fn() };
    const { Discovery, setServiceUrl } = runInNewContext(
        `${bundle.slice(start, end)}; ({ Discovery: O4, setServiceUrl: aetherSetCallServiceUrl })`,
        {
            Dt: (operation: () => unknown) => operation(),
            nr: (transport: { type: string }) => transport.type === "livekit",
        },
    ) as {
        Discovery: new (options: unknown) => { discoverPreferredTransport: () => Promise<unknown> };
        setServiceUrl: (provider: typeof hostServiceUrl | null) => void;
    };
    setServiceUrl(hostServiceUrl ?? null);
    return {
        direct,
        wait,
        client,
        discovery: new Discovery({
            client,
            logger,
            resolvedConfig: { livekit: { livekit_service_url: "https://configured" } },
        }),
    };
}

describe("Element Call transport discovery", () => {
    it("uses the Matrix client's transport cache instead of issuing another request", async () => {
        const transport = { type: "livekit", livekit_service_url: "https://cached" };
        const { direct, wait, discovery } = fixture(Promise.resolve([transport]));
        await expect(discovery.discoverPreferredTransport()).resolves.toEqual(transport);
        expect(wait).toHaveBeenCalledOnce();
        expect(direct).not.toHaveBeenCalled();
    });

    it("waits for discovery already in flight", async () => {
        let resolve!: (value: unknown[]) => void;
        const { direct, discovery } = fixture(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const done = vi.fn();
        const pending = discovery.discoverPreferredTransport().then(done);
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        resolve([{ type: "livekit", livekit_service_url: "https://pending" }]);
        await pending;
        expect(done).toHaveBeenCalledWith({ type: "livekit", livekit_service_url: "https://pending" });
        expect(direct).not.toHaveBeenCalled();
    });

    it("keeps the configured fallback when discovery is unsupported or empty", async () => {
        for (const cache of [Promise.resolve([]), Promise.reject(new Error("unsupported"))]) {
            const { direct, discovery } = fixture(cache);
            await expect(discovery.discoverPreferredTransport()).resolves.toEqual({
                type: "livekit",
                livekit_service_url: "https://configured",
            });
            expect(direct).not.toHaveBeenCalled();
        }
    });

    it("asks the host for the joining account's call service before the configured one", async () => {
        const host = vi.fn().mockResolvedValue("https://joining-account");
        const { client, discovery } = fixture(Promise.resolve([]), host);
        await expect(discovery.discoverPreferredTransport()).resolves.toEqual({
            type: "livekit",
            livekit_service_url: "https://joining-account",
        });
        expect(host).toHaveBeenCalledWith(client);
    });

    it("prefers transports the homeserver lists over the host's answer", async () => {
        const host = vi.fn().mockResolvedValue("https://joining-account");
        const transport = { type: "livekit", livekit_service_url: "https://listed" };
        const { discovery } = fixture(Promise.resolve([transport]), host);
        await expect(discovery.discoverPreferredTransport()).resolves.toEqual(transport);
        expect(host).not.toHaveBeenCalled();
    });

    it("falls back to configuration when the host has no answer or fails", async () => {
        for (const host of [vi.fn().mockResolvedValue(undefined), vi.fn().mockRejectedValue(new Error("broken"))]) {
            const { discovery } = fixture(Promise.resolve([]), host);
            await expect(discovery.discoverPreferredTransport()).resolves.toEqual({
                type: "livekit",
                livekit_service_url: "https://configured",
            });
        }
    });

    it("asks the server directly when the shared cache has no answer", async () => {
        const { direct, discovery } = fixture(Promise.resolve(undefined as unknown as unknown[]));
        await expect(discovery.discoverPreferredTransport()).resolves.toEqual({
            type: "livekit",
            livekit_service_url: "https://direct",
        });
        expect(direct).toHaveBeenCalledOnce();
    });

    it("supports clients without the host's cache", async () => {
        const { direct, discovery } = fixture();
        await expect(discovery.discoverPreferredTransport()).resolves.toEqual({
            type: "livekit",
            livekit_service_url: "https://direct",
        });
        expect(direct).toHaveBeenCalledOnce();
    });
});
