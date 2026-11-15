/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeserverFetchApi } from "shared-types";

import { desktopHomeserverFetch } from "./desktopHomeserverFetch";

describe("desktopHomeserverFetch", () => {
    let bridge: { fetch: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
    let pageFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        bridge = {
            fetch: vi.fn().mockResolvedValue({
                status: 200,
                statusText: "OK",
                headers: [["content-type", "application/json"]],
                body: new TextEncoder().encode('{"ok":true}').buffer,
            }),
            abort: vi.fn(),
        };
        window.electron = { homeserverFetch: bridge as unknown as HomeserverFetchApi } as Electron;
        pageFetch = vi.fn().mockResolvedValue(new Response("page"));
        vi.stubGlobal("fetch", pageFetch);
    });

    afterEach(() => {
        delete window.electron;
        vi.unstubAllGlobals();
    });

    it("is not used outside the desktop app", () => {
        delete window.electron;
        expect(desktopHomeserverFetch("https://matrix.example.org")).toBeUndefined();
    });

    it("hands homeserver requests to the desktop app and answers like fetch", async () => {
        const fetchFn = desktopHomeserverFetch("https://matrix.example.org")!;
        const response = await fetchFn("https://matrix.example.org/_matrix/client/v3/rooms/!a/send/m.room.message/1", {
            method: "PUT",
            headers: { "Authorization": "Bearer token", "Content-Type": "application/json" },
            body: '{"body":"hi"}',
        });
        const request = bridge.fetch.mock.calls[0]![0];
        expect(request).toMatchObject({
            id: expect.any(String),
            url: "https://matrix.example.org/_matrix/client/v3/rooms/!a/send/m.room.message/1",
            method: "PUT",
            body: '{"body":"hi"}',
        });
        // Header names are case-insensitive; the desktop app lowercases them.
        expect(request.headers.map(([name, value]: [string, string]) => [name.toLowerCase(), value])).toEqual([
            ["authorization", "Bearer token"],
            ["content-type", "application/json"],
        ]);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json");
        await expect(response.json()).resolves.toEqual({ ok: true });
        expect(pageFetch).not.toHaveBeenCalled();
    });

    it("leaves other servers and bodies other than text to the page's fetch", async () => {
        const fetchFn = desktopHomeserverFetch("https://matrix.example.org")!;
        await fetchFn("https://other.example.org/x");
        await fetchFn("https://matrix.example.org/_matrix/media/v3/upload", { method: "POST", body: new Blob(["x"]) });
        expect(pageFetch).toHaveBeenCalledTimes(2);
        expect(bridge.fetch).not.toHaveBeenCalled();
    });

    it("gives a response without a body for statuses that have none", async () => {
        bridge.fetch.mockResolvedValue({
            status: 204,
            statusText: "No Content",
            headers: [],
            body: new ArrayBuffer(0),
        });
        const response = await desktopHomeserverFetch("https://matrix.example.org")!("https://matrix.example.org/x");
        expect(response.status).toBe(204);
        expect(response.body).toBeNull();
    });

    it("rejects a failed request as fetch does", async () => {
        bridge.fetch.mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
        await expect(
            desktopHomeserverFetch("https://matrix.example.org")!("https://matrix.example.org/x"),
        ).rejects.toThrow(TypeError);
    });

    it("aborts the desktop app's request with the signal, rejecting with its reason", async () => {
        let fail!: (error: unknown) => void;
        bridge.fetch.mockReturnValue(new Promise((_, reject) => (fail = reject)));
        const controller = new AbortController();
        const request = desktopHomeserverFetch("https://matrix.example.org")!("https://matrix.example.org/sync", {
            signal: controller.signal,
        });
        controller.abort();
        expect(bridge.abort).toHaveBeenCalledWith(bridge.fetch.mock.calls[0]![0].id);
        fail(new Error("aborted in main"));
        await expect(request).rejects.toMatchObject({ name: "AbortError" });
    });
});
