/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteViewApi, SiteViewEvent, SiteViewState } from "shared-types";

import { samePage, SitePlayer, UnsupportedSitePlayer } from "./SitePlayer";
import type { WatchPlayerEvent } from "./WatchPlayer";
import { appPaintsOver } from "./appCover";

vi.mock("./appCover", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./appCover")>();
    return { ...actual, appPaintsOver: vi.fn(actual.appPaintsOver) };
});

const item = { id: "i1", source: "site" as const, ref: "https://archive.org/details/movie", addedBy: "@a:example.org" };

describe("SitePlayer", () => {
    let api: SiteViewApi & { emit(event: SiteViewEvent): void };
    let player: SitePlayer;
    let now: number;
    let events: WatchPlayerEvent[];

    const state = (patch: Partial<SiteViewState> = {}): SiteViewEvent => ({
        type: "state",
        state: { url: item.ref, title: "Movie", loading: false, canGoBack: false, video: null, ...patch },
    });
    const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    beforeEach(() => {
        now = 0;
        let listener: ((event: SiteViewEvent) => void) | undefined;
        api = {
            open: vi.fn().mockResolvedValue(undefined),
            setBounds: vi.fn(),
            command: vi.fn(),
            goBack: vi.fn(),
            close: vi.fn(),
            onEvent: (l) => {
                listener = l;
                return () => (listener = undefined);
            },
            emit: (event) => listener?.(event),
        };
        player = new SitePlayer(api, () => now);
        events = [];
        player.subscribe((event) => events.push(event));
    });

    afterEach(() => player.dispose());

    it("opens the shared page and waits for its video before taking commands", () => {
        player.load(item);
        expect(api.open).toHaveBeenCalledWith(item.ref);
        api.emit(state());
        expect(player.status()).toMatchObject({ ready: false, title: "Movie" });
        expect(player.page()).toMatchObject({ videoFound: false, onSharedPage: true });
        api.emit(state({ video: { paused: false, ended: false, buffering: false, time: 10, duration: 600, rate: 1 } }));
        now = 2000;
        expect(player.status()).toMatchObject({ ready: true, playing: true, time: 12, duration: 600 });
    });

    it("is not synced while browsing away from the shared page", () => {
        player.load(item);
        const video = { paused: true, ended: false, buffering: false, time: 0, duration: 60, rate: 1 };
        api.emit(state({ url: "https://archive.org/search?q=x", canGoBack: true, video }));
        expect(player.status().ready).toBe(false);
        expect(player.page()).toMatchObject({ onSharedPage: false, canGoBack: true });
        player.goBack();
        player.reopen();
        expect(api.goBack).toHaveBeenCalled();
        expect(api.open).toHaveBeenLastCalledWith(item.ref);
    });

    it("passes commands and the site's own video events through", () => {
        player.play();
        player.pause();
        player.seek(-3);
        player.setRate(1.5);
        player.setVolume(2);
        expect(vi.mocked(api.command).mock.calls.map(([c]) => c)).toEqual([
            { play: true },
            { pause: true },
            { seek: 0 },
            { rate: 1.5 },
            { volume: 1 },
        ]);
        api.emit({ type: "video", event: "seeked" });
        expect(events).toContain("seeked");
    });

    it("keeps the view over its element, and hides it when covered or off the page", async () => {
        document.body.appendChild(player.element);
        player.element.getBoundingClientRect = () => ({
            x: 10,
            y: 20,
            left: 10,
            top: 20,
            width: 640,
            height: 360,
            right: 650,
            bottom: 380,
            toJSON() {},
        });
        await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 640, height: 360 });
        player.setObscured(true);
        await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith(null);
        api.emit({ type: "snapshot", dataUrl: "data:image/jpeg;base64,AAAA" });
        expect(player.element.querySelector("img")).toHaveProperty("src", "data:image/jpeg;base64,AAAA");
        player.setObscured(false);
        await frame();
        const calls = vi.mocked(api.setBounds).mock.calls.length;
        await frame();
        // Nothing moved, so nothing is sent again.
        expect(vi.mocked(api.setBounds).mock.calls.length).toBe(calls);
    });

    it("hides the view while one of the app's menus reaches over it, wherever the menu was opened", async () => {
        const rect = (left: number, top: number, width: number, height: number) => (): DOMRect =>
            ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
        document.body.appendChild(player.element);
        player.element.getBoundingClientRect = rect(300, 100, 640, 360);
        // A member menu opened from the sidebar, portalled to the body like the real one.
        const menu = document.createElement("div");
        menu.setAttribute("role", "menu");
        menu.getBoundingClientRect = rect(10, 120, 200, 250);
        document.body.appendChild(menu);
        await frame();
        // Beside the player: the page stays visible.
        expect(api.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 100, width: 640, height: 360 });

        menu.getBoundingClientRect = rect(150, 120, 200, 250);
        await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith(null);

        menu.remove();
        await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 100, width: 640, height: 360 });

        // The sound board opened from the voice panel in the sidebar: a pop-up dialog, not a menu.
        const soundboard = document.createElement("div");
        soundboard.setAttribute("role", "dialog");
        soundboard.getBoundingClientRect = rect(200, 380, 900, 380);
        document.body.appendChild(soundboard);
        await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith(null);
        soundboard.remove();
        await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 100, width: 640, height: 360 });
    });

    it("waits for a few clean checks before showing the view again after something was drawn over it", async () => {
        document.body.appendChild(player.element);
        player.element.getBoundingClientRect = (): DOMRect =>
            ({ x: 300, y: 100, left: 300, top: 100, width: 640, height: 360, right: 940, bottom: 460 }) as DOMRect;
        const shown = { x: 300, y: 100, width: 640, height: 360 };
        await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith(shown);
        // Something moving over the player is found by one check and falls between the sample points on the next.
        vi.mocked(appPaintsOver).mockReturnValueOnce(true);
        for (let i = 0; i < 8 && vi.mocked(api.setBounds).mock.lastCall?.[0] !== null; i++) await frame();
        expect(api.setBounds).toHaveBeenLastCalledWith(null);
        let frames = 0;
        while (vi.mocked(api.setBounds).mock.lastCall?.[0] === null && frames < 40) {
            await frame();
            frames++;
        }
        // Three more checks, a few frames apart, found nothing before the view came back.
        expect(frames).toBeGreaterThanOrEqual(13);
        expect(api.setBounds).toHaveBeenLastCalledWith(shown);
    });

    it("closes the view when disposed", () => {
        player.dispose();
        expect(api.close).toHaveBeenCalled();
    });
});

describe("samePage", () => {
    it("ignores fragments, YouTube's time and parameter order", () => {
        expect(samePage("https://a.example/watch?x=1&y=2#top", "https://a.example/watch?y=2&x=1")).toBe(true);
        expect(samePage("https://a.example/v?t=30", "https://a.example/v")).toBe(true);
        expect(samePage("https://a.example/one", "https://a.example/two")).toBe(false);
    });
});

describe("UnsupportedSitePlayer", () => {
    it("explains that websites need the desktop app", () => {
        const player = new UnsupportedSitePlayer();
        player.load(item);
        expect(player.status()).toMatchObject({ ready: false, error: "needs_desktop" });
        expect(player.itemRef).toBe(item.ref);
    });
});
