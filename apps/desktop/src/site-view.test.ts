/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { isSiteUrl, parseCommand, parseFrameReport, plainChromeUserAgent } from "./site-view.js";

vi.mock("electron", () => ({
    app: { userAgentFallback: "" },
    ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
    session: { fromPartition: vi.fn() },
    shell: { openExternal: vi.fn() },
    WebContentsView: vi.fn(),
}));

describe("site view", () => {
    it("presents itself to sites as plain Chrome", () => {
        expect(
            plainChromeUserAgent(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Aether/0.1.15 Chrome/146.0.0.0 Electron/44.9.0 Safari/537.36",
            ),
        ).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36");
    });

    it("opens only web pages", () => {
        expect(isSiteUrl("https://archive.org/details/x")).toBe(true);
        expect(isSiteUrl("http://example.org/")).toBe(true);
        for (const url of ["vector://vector/webapp/", "file:///etc/passwd", "javascript:alert(1)", "not a url", 42])
            expect(isSiteUrl(url)).toBe(false);
    });

    it("accepts well-formed frame reports and drops unknown fields", () => {
        const video = { paused: false, ended: false, buffering: false, time: 12.5, duration: 600, rate: 1, extra: 1 };
        expect(parseFrameReport({ score: 3, video, event: "seeked", html: "<x>" })).toEqual({
            score: 3,
            video: { paused: false, ended: false, buffering: false, time: 12.5, duration: 600, rate: 1 },
            event: "seeked",
        });
        expect(parseFrameReport({ score: 0, video: null })).toEqual({ score: 0, video: null });
        expect(parseFrameReport({ score: 1, video: null, event: "explode" })).toEqual({ score: 1, video: null });
    });

    it.each([
        ["a negative score", { score: -1, video: null }],
        ["a missing score", { video: null }],
        [
            "a non-numeric time",
            { score: 1, video: { paused: true, ended: false, buffering: false, time: "1", duration: null, rate: 1 } },
        ],
        [
            "an infinite duration",
            { score: 1, video: { paused: true, ended: false, buffering: false, time: 1, duration: Infinity, rate: 1 } },
        ],
        ["nothing", null],
    ])("rejects a report with %s", (_, report) => {
        expect(parseFrameReport(report)).toBeUndefined();
    });

    it("passes on only the commands the page understands, within sensible ranges", () => {
        expect(parseCommand({ play: true })).toEqual({ play: true });
        expect(parseCommand({ pause: true })).toEqual({ pause: true });
        expect(parseCommand({ seek: 42 })).toEqual({ seek: 42 });
        expect(parseCommand({ rate: 1.5 })).toEqual({ rate: 1.5 });
        expect(parseCommand({ volume: 0 })).toEqual({ volume: 0 });
        for (const bad of [{ seek: -1 }, { rate: 16 }, { volume: 2 }, { play: "yes" }, { eval: "x" }, null])
            expect(parseCommand(bad)).toBeUndefined();
    });
});
