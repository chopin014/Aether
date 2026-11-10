/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act, render, waitFor } from "test-utils-rtl";

import dis from "../../../dispatcher/dispatcher";
import EffectsOverlay from "./EffectsOverlay.tsx";

/** Stands in for the browser's ResizeObserver, reporting the room's width when asked. */
class FakeResizeObserver {
    public static instances: FakeResizeObserver[] = [];
    /** Whether the room is measured as soon as it is observed, as a browser does once it next lays out. */
    public static measureAtOnce = true;
    public constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
    }
    public observe = vi.fn(() => {
        if (FakeResizeObserver.measureAtOnce) this.report(100);
    });
    public disconnect = vi.fn();
    public report(width: number): void {
        this.callback([{ borderBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry], this as never);
    }
}

describe("<EffectsOverlay/>", () => {
    let isStarted: boolean;
    let isStopped: boolean;
    let startedAtWidth: number | undefined;
    let room: HTMLElement;
    beforeEach(() => {
        FakeResizeObserver.instances = [];
        FakeResizeObserver.measureAtOnce = true;
        startedAtWidth = undefined;
        isStopped = false;
        vi.stubGlobal("ResizeObserver", FakeResizeObserver);
        room = document.createElement("div");
        isStarted = false;
        vi.doMock("../../../effects/confetti/index.ts", () => {
            return {
                default: class Confetti {
                    public isRunning = false;
                    start = (canvas: HTMLCanvasElement) => {
                        isStarted = true;
                        startedAtWidth = canvas.width;
                        this.isRunning = true;
                    };
                    stop = vi.fn(() => {
                        isStopped = true;
                    });
                },
            };
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("should render", () => {
        const { asFragment } = render(<EffectsOverlay room={room} />);
        expect(asFragment()).toMatchSnapshot();
    });

    it("should start the confetti effect", async () => {
        render(<EffectsOverlay room={room} />);
        dis.dispatch({ action: "effects.confetti" });
        await waitFor(() => expect(isStarted).toBe(true));
    });

    it("should start the confetti effect when the event is not outdated", async () => {
        const eventDate = new Date("2024-09-01");
        const date = new Date("2024-09-02");
        vi.setSystemTime(date);

        render(<EffectsOverlay room={room} />);
        dis.dispatch({ action: "effects.confetti", event: { getTs: () => eventDate.getTime() } });
        await waitFor(() => expect(isStarted).toBe(true));
    });

    it("is as wide as the room, as the browser lays the room out", () => {
        const { container, unmount } = render(<EffectsOverlay room={room} />);
        const [observer] = FakeResizeObserver.instances;
        expect(observer.observe).toHaveBeenCalledWith(room, { box: "border-box" });
        expect(container.querySelector("canvas")).toHaveAttribute("width", "100");

        act(() => observer.report(321.4));
        expect(container.querySelector("canvas")).toHaveAttribute("width", "321");

        unmount();
        expect(observer.disconnect).toHaveBeenCalled();
    });

    it("starts an effect asked for before the room is measured once the canvas is as wide as the room", async () => {
        FakeResizeObserver.measureAtOnce = false;
        render(<EffectsOverlay room={room} />);
        dis.dispatch({ action: "effects.confetti" }, true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(isStarted).toBe(false);

        act(() => FakeResizeObserver.instances[0].report(480));
        await waitFor(() => expect(isStarted).toBe(true));
        expect(startedAtWidth).toBe(480);
    });

    it("stops a running effect when it goes away", async () => {
        const { unmount } = render(<EffectsOverlay room={room} />);
        dis.dispatch({ action: "effects.confetti" }, true);
        await waitFor(() => expect(isStarted).toBe(true));

        unmount();
        expect(isStopped).toBe(true);
    });
});
