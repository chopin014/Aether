/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import type { HomeserverFetchRequest, HomeserverFetchResponse } from "shared-types";

import {
    HOMESERVER_FETCH,
    HOMESERVER_FETCH_ABORT,
    PREFLIGHT_POLICY_MS,
    setupHomeserverFetch,
} from "./homeserver-fetch.js";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

const ORIGIN = "vector://vector";
const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization",
};

describe("homeserver fetch", () => {
    let sessionFetch: ReturnType<typeof vi.fn>;
    let handle: (event: unknown, request: HomeserverFetchRequest) => Promise<HomeserverFetchResponse>;
    let abort: (event: unknown, id: string) => void;
    let event: {
        sender: { id: number; mainFrame: object; session: { fetch: ReturnType<typeof vi.fn> } };
        senderFrame: object;
    };

    const request = (overrides: Partial<HomeserverFetchRequest> = {}): HomeserverFetchRequest => ({
        id: "1",
        url: "https://matrix.example.org/_matrix/client/v3/rooms/!a/send/m.room.message/1",
        method: "PUT",
        headers: [
            ["Authorization", "Bearer token"],
            ["Content-Type", "application/json"],
        ],
        body: "{}",
        ...overrides,
    });
    const methods = (): string[] => sessionFetch.mock.calls.map(([, init]) => init.method);

    beforeEach(() => {
        vi.useRealTimers();
        vi.mocked(ipcMain.handle).mockReset();
        vi.mocked(ipcMain.on).mockReset();
        sessionFetch = vi.fn(async (_url: string, init: RequestInit) =>
            init.method === "OPTIONS"
                ? new Response(null, { status: 204, headers: CORS })
                : new Response('{"event_id":"$1"}', { status: 200, headers: { ...CORS, "set-cookie": "a=b" } }),
        );
        const mainFrame = { origin: ORIGIN };
        event = { sender: { id: 1, mainFrame, session: { fetch: sessionFetch } }, senderFrame: mainFrame };
        setupHomeserverFetch();
        handle = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === HOMESERVER_FETCH)![1] as never;
        abort = vi.mocked(ipcMain.on).mock.calls.find(([channel]) => channel === HOMESERVER_FETCH_ABORT)![1] as never;
    });

    it("asks the server's permission once per origin, not before every request", async () => {
        const first = await handle(event, request());
        expect(methods()).toEqual(["OPTIONS", "PUT"]);
        expect(sessionFetch.mock.calls[0]![1].headers).toEqual({
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "authorization,content-type",
        });
        await handle(event, request({ id: "2", url: "https://matrix.example.org/_matrix/client/v3/sendToDevice/m/2" }));
        await handle(
            event,
            request({ id: "3", method: "POST", url: "https://matrix.example.org/_matrix/client/v3/keys/query" }),
        );
        expect(methods()).toEqual(["OPTIONS", "PUT", "PUT", "POST"]);
        expect(first.status).toBe(200);
        expect(new TextDecoder().decode(first.body!)).toBe('{"event_id":"$1"}');
    });

    it("asks again once the permission has expired", async () => {
        vi.useFakeTimers();
        await handle(event, request());
        vi.advanceTimersByTime(PREFLIGHT_POLICY_MS);
        await handle(event, request({ id: "2" }));
        expect(methods()).toEqual(["OPTIONS", "PUT", "OPTIONS", "PUT"]);
    });

    it("sends no cookies, no origin, and none of the headers a page may not set", async () => {
        await handle(
            event,
            request({
                headers: [...request().headers, ["Cookie", "a=b"], ["Host", "evil"], ["Sec-Fetch-Mode", "cors"]],
            }),
        );
        const [url, init] = sessionFetch.mock.calls[1]!;
        expect(url).toBe(request().url);
        expect(init).toMatchObject({ method: "PUT", body: "{}", credentials: "omit" });
        // No Origin: Chromium would treat the request as the page's and ask the server again.
        expect(init.headers).toEqual([
            ["authorization", "Bearer token"],
            ["content-type", "application/json"],
        ]);
    });

    it("hands back no cookies, and no body where a status has none", async () => {
        sessionFetch.mockImplementation(async (_url: string, init: RequestInit) =>
            init.method === "OPTIONS"
                ? new Response(null, { status: 204, headers: CORS })
                : new Response(null, { status: 204, headers: { ...CORS, "set-cookie": "a=b" } }),
        );
        const response = await handle(event, request());
        expect(response.headers.some(([name]) => name === "set-cookie")).toBe(false);
        expect(response.body).toBeNull();
    });

    it("sends a simple request without asking first", async () => {
        await handle(event, request({ method: "GET", headers: [["Accept", "application/json"]], body: undefined }));
        expect(methods()).toEqual(["GET"]);
    });

    it.each([
        ["no Access-Control-Allow-Origin", { ...CORS, "access-control-allow-origin": "" }],
        ["another origin", { ...CORS, "access-control-allow-origin": "https://other.example.org" }],
        ["no PUT", { ...CORS, "access-control-allow-methods": "GET, POST" }],
        ["Authorization only through a wildcard", { ...CORS, "access-control-allow-headers": "*" }],
    ])("refuses a request the server's answer does not allow (%s)", async (_, headers) => {
        sessionFetch.mockImplementation(async () => new Response(null, { status: 204, headers }));
        await expect(handle(event, request())).rejects.toThrow("CORS preflight refused");
        expect(methods()).toEqual(["OPTIONS"]);
    });

    it("hands back no response the server does not let the page read", async () => {
        sessionFetch.mockImplementation(async (_url: string, init: RequestInit) =>
            init.method === "OPTIONS"
                ? new Response(null, { status: 204, headers: CORS })
                : new Response("secret", { status: 200 }),
        );
        await expect(handle(event, request())).rejects.toThrow("does not let");
    });

    it.each([
        ["a plain HTTP server elsewhere", request({ url: "http://matrix.example.org/x" })],
        ["a file", request({ url: "file:///etc/passwd" })],
        ["an odd method", request({ method: "CONNECT" })],
        ["a body that is not text", request({ body: 1 as unknown as string })],
    ])("refuses %s", async (_, refused) => {
        await expect(handle(event, refused)).rejects.toThrow();
        expect(sessionFetch).not.toHaveBeenCalled();
    });

    it("serves a homeserver on this machine over plain HTTP", async () => {
        await handle(event, request({ url: "http://localhost:8008/_matrix/client/v3/sync" }));
        expect(methods()).toEqual(["OPTIONS", "PUT"]);
    });

    it("serves only the app itself, not a frame it shows", async () => {
        await expect(
            handle({ ...event, senderFrame: { origin: "https://widget.example.org" } }, request()),
        ).rejects.toThrow("Not available to this frame");
        expect(sessionFetch).not.toHaveBeenCalled();
    });

    it("aborts a request the page aborts", async () => {
        let signal: AbortSignal | undefined;
        sessionFetch.mockImplementation(async (_url: string, init: RequestInit) => {
            if (init.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
            signal = init.signal ?? undefined;
            return new Promise<Response>((_, reject) =>
                signal!.addEventListener("abort", () => reject(signal!.reason)),
            );
        });
        const pending = handle(event, request({ id: "sync" }));
        await vi.waitFor(() => expect(signal).toBeDefined());
        abort(event, "sync");
        expect(signal!.aborted).toBe(true);
        await expect(pending).rejects.toThrow();
    });
});
