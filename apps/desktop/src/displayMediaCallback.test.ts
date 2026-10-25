/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    consumeDisplayMediaCallback,
    getDisplayMediaSource,
    setDisplayMediaCallback,
    setDisplayMediaSources,
} from "./displayMediaCallback.js";

describe("displayMediaCallback", () => {
    beforeEach(() => {
        setDisplayMediaCallback(null);
    });

    it("starts empty", () => {
        expect(consumeDisplayMediaCallback()).toBeNull();
    });

    it("returns the stored callback once, then clears it (consume-once)", () => {
        const callback = (): void => {};
        setDisplayMediaCallback(callback);

        expect(consumeDisplayMediaCallback()).toBe(callback);
        expect(consumeDisplayMediaCallback()).toBeNull();
    });

    it("setDisplayMediaCallback(null) clears a pending callback", () => {
        setDisplayMediaCallback((): void => {});
        setDisplayMediaCallback(null);

        expect(consumeDisplayMediaCallback()).toBeNull();
    });

    it("cancels an earlier pending picker when a new request replaces it", () => {
        const earlier = vi.fn();
        const current = vi.fn();
        setDisplayMediaCallback(earlier);
        setDisplayMediaCallback(current);
        expect(earlier).toHaveBeenCalledExactlyOnceWith({ video: { id: "", name: "" } });
        expect(consumeDisplayMediaCallback()).toBe(current);
        expect(current).not.toHaveBeenCalled();
    });

    it("keeps only native sources from the current pending picker", () => {
        const source = { id: "screen:1", name: "Native screen" } as Electron.DesktopCapturerSource;
        setDisplayMediaSources([source]);
        expect(getDisplayMediaSource(source.id)).toBeUndefined();
        setDisplayMediaCallback(vi.fn());
        setDisplayMediaSources([source]);
        expect(getDisplayMediaSource(source.id)).toBe(source);
        expect(getDisplayMediaSource("screen:forged")).toBeUndefined();
        consumeDisplayMediaCallback();
        expect(getDisplayMediaSource(source.id)).toBeUndefined();
    });
});
