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
    public constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
    }
    public observe = vi.fn(() => this.report(100));
    public disconnect = vi.fn();
    public report(width: number): void {
        this.callback([{ borderBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry], this as never);
    }
}

describe("<EffectsOverlay/>", () => {
    let isStarted: boolean;
    let room: HTMLElement;
    beforeEach(() => {
        FakeResizeObserver.instances = [];
        vi.stubGlobal("ResizeObserver", FakeResizeObserver);
        room = document.createElement("div");
        isStarted = false;
        vi.doMock("../../../effects/confetti/index.ts", () => {
            return {
                default: class Confetti {
                    start = () => {
                        isStarted = true;
                    };
                    stop = vi.fn();
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
        expect(observer.observe).toHaveBeenCalledWith(room);
        expect(container.querySelector("canvas")).toHaveAttribute("width", "100");

        act(() => observer.report(321.4));
        expect(container.querySelector("canvas")).toHaveAttribute("width", "321");

        unmount();
        expect(observer.disconnect).toHaveBeenCalled();
    });
});
