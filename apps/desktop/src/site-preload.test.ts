/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { findVideos, pickVideo, videoScore, videoState } from "./site-preload.cjs";

vi.mock("electron", () => ({ ipcRenderer: { send: vi.fn(), on: vi.fn() }, webFrame: { executeJavaScript: vi.fn() } }));

/** A video with the given size on screen, picture size and length, ready to play. */
function video(box: { width: number; height: number }, size: [number, number], duration: number): HTMLVideoElement {
    const element = document.createElement("video");
    document.body.appendChild(element);
    Object.defineProperties(element, {
        readyState: { value: 4, configurable: true },
        videoWidth: { value: size[0], configurable: true },
        videoHeight: { value: size[1], configurable: true },
        duration: { value: duration, configurable: true },
    });
    element.getBoundingClientRect = () => ({ ...box, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} });
    return element;
}

describe("site preload", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("prefers the big, long video over previews and backgrounds", () => {
        const preview = video({ width: 320, height: 180 }, [640, 360], 15);
        const movie = video({ width: 1280, height: 720 }, [1920, 1080], 5400);
        const tiny = video({ width: 40, height: 30 }, [1920, 1080], 9999);
        expect(videoScore(tiny)).toBe(0);
        expect(pickVideo([preview, movie, tiny], null)).toEqual({ video: movie, score: videoScore(movie) });
    });

    it("scores a live stream as an hour-long video", () => {
        const live = video({ width: 1280, height: 720 }, [1280, 720], Infinity);
        expect(videoScore(live)).toBe(1280 * 720 * 3601);
    });

    it("ignores videos that are not loaded or not shown", () => {
        const notLoaded = video({ width: 1280, height: 720 }, [1280, 720], 600);
        Object.defineProperty(notLoaded, "readyState", { value: 0 });
        const hidden = video({ width: 1280, height: 720 }, [1280, 720], 600);
        hidden.style.visibility = "hidden";
        expect(videoScore(notLoaded)).toBe(0);
        expect(videoScore(hidden)).toBe(0);
    });

    it("keeps the current video unless another clearly beats it", () => {
        const current = video({ width: 1280, height: 720 }, [1280, 720], 600);
        const similar = video({ width: 1280, height: 720 }, [1280, 800], 600);
        expect(pickVideo([similar, current], current).video).toBe(current);
        const muchBetter = video({ width: 1280, height: 720 }, [1920, 1080], 6000);
        expect(pickVideo([muchBetter, current], current).video).toBe(muchBetter);
    });

    it("finds videos inside open shadow roots only when asked to look deep", () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.appendChild(document.createElement("video"));
        document.body.appendChild(document.createElement("video"));
        expect(findVideos(document, false)).toHaveLength(1);
        expect(findVideos(document, true)).toHaveLength(2);
    });

    it("reports a video's playback, treating an unknown length as none", () => {
        const element = video({ width: 1280, height: 720 }, [1280, 720], NaN);
        expect(videoState(element)).toMatchObject({ paused: true, ended: false, duration: null, rate: 1 });
    });
});
