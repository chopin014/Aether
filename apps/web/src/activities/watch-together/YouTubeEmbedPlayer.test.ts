/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YOUTUBE_EMBED_ORIGIN, YouTubeEmbedPlayer } from "./YouTubeEmbedPlayer";
import type { WatchPlayerEvent } from "./WatchPlayer";

const item = { id: "i1", source: "youtube" as const, ref: "aqz-KE-bpKQ", addedBy: "@a:example.org" };

describe("YouTubeEmbedPlayer", () => {
    let now: number;
    let player: YouTubeEmbedPlayer;
    let iframe: HTMLIFrameElement;
    let posted: Record<string, unknown>[];
    let events: WatchPlayerEvent[];

    function fromEmbed(data: unknown, origin = YOUTUBE_EMBED_ORIGIN, source = iframe.contentWindow): void {
        window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data), origin, source }));
    }

    /** Records what is posted to the frame; it gets a new window when its address is set, so this runs after. */
    const spied = new WeakSet<Window>();
    function recordFrame(): void {
        const frame = iframe.contentWindow!;
        if (spied.has(frame)) return;
        spied.add(frame);
        vi.spyOn(frame, "postMessage").mockImplementation((message: unknown) => {
            posted.push(JSON.parse(message as string));
        });
    }

    /** Loads an item and lets the frame finish loading, as the browser would. */
    function loadFrame(...args: Parameters<YouTubeEmbedPlayer["load"]>): void {
        player.load(...args);
        recordFrame();
        iframe.dispatchEvent(new Event("load"));
    }

    beforeEach(() => {
        vi.useFakeTimers();
        now = 0;
        player = new YouTubeEmbedPlayer(() => now);
        document.body.appendChild(player.element);
        iframe = player.element.querySelector("iframe")!;
        posted = [];
        events = [];
        player.subscribe((event) => events.push(event));
    });

    afterEach(() => {
        player.dispose();
        vi.useRealTimers();
    });

    const commands = (): unknown[] => posted.filter((m) => m.event === "command").map((m) => [m.func, m.args]);

    it("embeds the video without YouTube's controls, at the requested second", () => {
        player.load(item, 42.7, true);
        const url = new URL(iframe.src);
        expect(url.origin + url.pathname).toBe("https://www.youtube.com/embed/aqz-KE-bpKQ");
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            enablejsapi: "1",
            controls: "0",
            disablekb: "1",
            start: "42",
        });
        expect(iframe.allow).toContain("autoplay");
        expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    });

    it("repeats the handshake until the embed answers, then sends what was asked meanwhile", () => {
        player.load(item, 0, false);
        player.play();
        player.setRate(1.5);
        recordFrame();
        iframe.dispatchEvent(new Event("load"));
        vi.advanceTimersByTime(600);
        expect(posted.filter((m) => m.event === "listening").length).toBeGreaterThanOrEqual(3);
        expect(commands()).toEqual([]);
        fromEmbed({ event: "onReady", id: 1 });
        // Only the latest play or pause is kept.
        expect(commands()).toEqual([
            ["setVolume", [100]],
            ["playVideo", []],
            ["setPlaybackRate", [1.5]],
        ]);
        const count = posted.length;
        vi.advanceTimersByTime(1000);
        expect(posted.length).toBe(count);
    });

    it("ignores messages from other frames and origins", () => {
        loadFrame(item, 0, false);
        fromEmbed({ event: "infoDelivery", info: { playerState: 1 } }, "https://evil.example");
        fromEmbed({ event: "infoDelivery", info: { playerState: 1 } }, YOUTUBE_EMBED_ORIGIN, window);
        expect(player.status()).toMatchObject({ ready: false, playing: false });
    });

    it("reports time, length, speed and title, projecting the time forward while playing", () => {
        loadFrame(item, 0, true);
        fromEmbed({
            event: "infoDelivery",
            info: { playerState: 1, currentTime: 10, duration: 600, playbackRate: 2, videoData: { title: "Bunny" } },
        });
        now = 1500;
        expect(player.status()).toMatchObject({
            ready: true,
            playing: true,
            time: 13,
            duration: 600,
            rate: 2,
            title: "Bunny",
        });
        expect(events).toContain("playing");
    });

    it("tells a pause from playback, buffering and the end", () => {
        loadFrame(item, 0, true);
        fromEmbed({ event: "infoDelivery", info: { playerState: 3 } });
        expect(player.status()).toMatchObject({ playing: true, buffering: true });
        fromEmbed({ event: "infoDelivery", info: { playerState: 1 } });
        fromEmbed({ event: "infoDelivery", info: { playerState: 2 } });
        fromEmbed({ event: "infoDelivery", info: { playerState: 0 } });
        expect(events.filter((e) => e !== "status")).toEqual(["playing", "paused", "ended"]);
    });

    it("ignores the previous video's end reported just after switching", () => {
        loadFrame(item, 0, true);
        fromEmbed({ event: "onReady" });
        fromEmbed({ event: "infoDelivery", info: { playerState: 1 } });
        fromEmbed({ event: "infoDelivery", info: { playerState: 0 } });
        expect(events.filter((e) => e === "ended")).toHaveLength(1);
        player.load({ ...item, id: "i2", ref: "jNQXAC9IVRw" }, 0, true);
        fromEmbed({ event: "infoDelivery", info: { playerState: 0 } });
        expect(events.filter((e) => e === "ended")).toHaveLength(1);
        fromEmbed({ event: "infoDelivery", info: { playerState: 1 } });
        fromEmbed({ event: "infoDelivery", info: { playerState: 0 } });
        expect(events.filter((e) => e === "ended")).toHaveLength(2);
    });

    it.each([
        [150, "not_embeddable"],
        [101, "not_embeddable"],
        [100, "not_found"],
        [5, "unplayable"],
    ])("reports YouTube error %s as %s", (code, error) => {
        loadFrame(item, 0, true);
        fromEmbed({ event: "onError", info: code });
        expect(player.status().error).toBe(error);
        expect(events).toContain("error");
    });

    it("switches videos without reloading the frame", () => {
        loadFrame(item, 0, true);
        fromEmbed({ event: "onReady" });
        const src = iframe.src;
        player.load({ ...item, id: "i2", ref: "jNQXAC9IVRw" }, 12.5, false);
        expect(iframe.src).toBe(src);
        expect(commands().at(-1)).toEqual(["cueVideoById", [{ videoId: "jNQXAC9IVRw", startSeconds: 12.5 }]]);
        player.load({ ...item, id: "i3" }, 0, true);
        expect(commands().at(-1)).toEqual(["loadVideoById", [{ videoId: "aqz-KE-bpKQ", startSeconds: 0 }]]);
    });

    it("asks to be loaded again when the frame reloads after being moved", () => {
        loadFrame(item, 0, true);
        fromEmbed({ event: "onReady" });
        iframe.dispatchEvent(new Event("load"));
        expect(events).toContain("reset");
        expect(player.status().ready).toBe(false);
    });

    it("mutes at zero volume and passes other volumes as percentages", () => {
        loadFrame(item, 0, true);
        fromEmbed({ event: "onReady" });
        player.setVolume(0.35);
        player.setVolume(0);
        expect(commands().slice(-4)).toEqual([
            ["setVolume", [35]],
            ["unMute", []],
            ["setVolume", [0]],
            ["mute", []],
        ]);
    });

    it("stops listening and empties the frame when disposed", () => {
        player.load(item, 0, true);
        player.dispose();
        expect(iframe.getAttribute("src")).toBeNull();
        expect(player.element.isConnected).toBe(false);
    });
});
