/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HtmlMediaPlayer } from "./HtmlMediaPlayer";
import type { WatchPlayerEvent } from "./WatchPlayer";

const item = { id: "i1", source: "media" as const, ref: "https://example.org/a.mp4", addedBy: "@a:example.org" };

describe("HtmlMediaPlayer", () => {
    let player: HtmlMediaPlayer;
    let events: WatchPlayerEvent[];

    beforeEach(() => {
        player = new HtmlMediaPlayer();
        document.body.appendChild(player.element);
        vi.spyOn(player.element, "play").mockResolvedValue(undefined);
        vi.spyOn(player.element, "pause").mockImplementation(() => {});
        vi.spyOn(player.element, "load").mockImplementation(() => {});
        events = [];
        player.subscribe((event) => events.push(event));
    });

    afterEach(() => player.dispose());

    it("loads the file at the shared position and plays it when asked", () => {
        player.load(item, 12, true);
        expect(player.element.src).toBe(item.ref);
        expect(player.element.currentTime).toBe(12);
        expect(player.element.play).toHaveBeenCalled();
        expect(player.itemId).toBe("i1");
    });

    it("applies speed and this device's volume", () => {
        player.setRate(1.5);
        player.setVolume(0);
        expect(player.element.playbackRate).toBe(1.5);
        expect(player.element.muted).toBe(true);
        player.setVolume(0.5);
        expect(player.element.volume).toBe(0.5);
        expect(player.element.muted).toBe(false);
    });

    it("reports a pause only while the element is on screen", () => {
        player.element.dispatchEvent(new Event("pause"));
        player.element.remove();
        player.element.dispatchEvent(new Event("pause"));
        expect(events.filter((e) => e === "paused")).toHaveLength(1);
    });

    it("passes on playing, ended and errors", () => {
        player.element.dispatchEvent(new Event("playing"));
        player.element.dispatchEvent(new Event("ended"));
        Object.defineProperty(player.element, "error", { value: { code: 4 }, configurable: true });
        player.element.dispatchEvent(new Event("error"));
        expect(events).toEqual(["playing", "ended", "error"]);
        expect(player.status().error).toBe("unplayable");
    });

    it("has no position before anything is loaded", () => {
        expect(player.status()).toMatchObject({ ready: false, time: null, duration: null });
    });
});
