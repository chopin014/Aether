/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ScrollPanel from "./ScrollPanel";
import roomViewCss from "../../../res/css/structures/_RoomView.pcss?raw";
import "@element-hq/web-shared-components/dist/element-web-shared-components.css";

// Load the production scrollbar without the unrelated shared component barrel's browser setup.
vi.mock(
    "@element-hq/web-shared-components",
    // Import the real scrollbar alone: the package barrel also initializes unrelated browser globals.
    // eslint-disable-next-line no-restricted-imports
    async () => import("../../../../../packages/shared-components/src/core/utils/Scrollbar/AutoHideScrollbar"),
);
vi.mock("../../accessibility/KeyboardShortcuts", () => ({ KeyBindingAction: {} }));
vi.mock("../../settings/SettingsStore", () => ({ default: { getValue: () => false } }));
vi.mock("../../KeyBindingsManager", () => ({ getKeyBindingsManager: vi.fn<() => void>() }));
vi.mock("../../contexts/SDKContext", async () => ({ SDKContext: (await import("react")).createContext(undefined) }));

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// Use actual layout: DOM-only tests cannot expose scroll clamping or message offsets.
describe("ScrollPanel anchoring", () => {
    let container: HTMLDivElement;
    let style: HTMLStyleElement;
    let root: Root;
    const panel = createRef<ScrollPanel>();
    let messages: { id: string; height: number }[];
    let viewportHeight: number;
    let stickyBottom: boolean;

    const render = (): void => {
        flushSync(() =>
            root.render(
                <ScrollPanel
                    ref={panel}
                    stickyBottom={stickyBottom}
                    className="mx_RoomView_messagePanel"
                    style={{ height: viewportHeight, width: 500, flex: "none" }}
                >
                    {messages.map(({ id, height }) => (
                        <li key={id} data-scroll-tokens={id} style={{ height, flexShrink: 0 }}>
                            Message {id}
                        </li>
                    ))}
                </ScrollPanel>,
            ),
        );
    };

    beforeEach(async () => {
        style = document.createElement("style");
        style.textContent = roomViewCss;
        document.head.appendChild(style);
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        viewportHeight = 300;
        stickyBottom = true;
        messages = Array.from({ length: 80 }, (_, i) => ({ id: `event-${i}`, height: 40 }));
        render();
        await frame();
        await frame();
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
        style.remove();
    });

    const node = (): HTMLDivElement => panel.current!.divScroll!;
    const tile = (index: number): HTMLElement => container.querySelector(`[data-scroll-tokens="event-${index}"]`)!;
    const top = (index: number): number => tile(index).getBoundingClientRect().top - node().getBoundingClientRect().top;
    const anchor = async (index = 40): Promise<void> => {
        panel.current!.scrollToToken(`event-${index}`, -100);
        await frame();
        await new Promise((resolve) => setTimeout(resolve, 150));
    };

    it("keeps the message in place when content above and below changes height", async () => {
        await anchor();
        const y = top(40);
        messages[10].height += 250;
        render();
        panel.current!.checkScroll();
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(Math.abs(top(40) - y)).toBeLessThanOrEqual(1);
        messages[60].height += 250;
        render();
        panel.current!.checkScroll();
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(Math.abs(top(40) - y)).toBeLessThanOrEqual(1);
    });

    it("does not cancel a user scroll that precedes a React update in the same frame", async () => {
        await anchor();
        const y = top(40);
        node().scrollBy(0, -120);
        render();
        await frame();
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(top(40)).toBeCloseTo(y + 120, 0);
    });

    it("keeps the message being read in place when a later visible message expands", async () => {
        await anchor();
        const y = top(40);
        messages[41].height += 500;
        render();
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(Math.abs(top(40) - y)).toBeLessThanOrEqual(1);
    });

    it("preserves the reading position when height rebasing clamps the scrollbar", async () => {
        await anchor(74);
        node().scrollBy(0, 1);
        await frame();
        messages[79].height += 500;
        render();
        node().scrollBy(0, 500);
        await frame();
        const y = top(79);
        await new Promise((resolve) => setTimeout(resolve, 180));
        expect(Math.abs(top(79) - y)).toBeLessThanOrEqual(1);
    });

    it("does not jump back to the bottom when a new message arrives during scroll-away", async () => {
        panel.current!.scrollToBottom();
        await frame();
        const before = node().scrollTop;
        node().scrollBy(0, -120);
        messages.push({ id: "event-80", height: 40 });
        render();
        await frame();
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(node().scrollTop).toBeLessThan(before);
        expect(panel.current!.getScrollState().stuckAtBottom).toBe(false);
    });

    it("continues following new messages while at the bottom", async () => {
        messages.push({ id: "event-80", height: 150 });
        render();
        await frame();
        expect(panel.current!.isAtBottom()).toBe(true);
        expect(panel.current!.getScrollState().stuckAtBottom).toBe(true);
    });

    it("does not cancel scrolling away when a media resize is reported before the scroll event", async () => {
        const before = node().scrollTop;
        node().scrollBy(0, -120);
        tile(79).style.height = "500px";
        panel.current!.checkScroll();
        await frame();
        expect(node().scrollTop).toBeLessThan(before);
        expect(panel.current!.getScrollState().stuckAtBottom).toBe(false);
    });

    it("keeps following the bottom when media changes height before React updates", async () => {
        messages[79].height += 500;
        tile(79).style.height = `${messages[79].height}px`;
        render();
        await frame();
        expect(panel.current!.isAtBottom()).toBe(true);
        expect(panel.current!.getScrollState().stuckAtBottom).toBe(true);
    });

    it("preserves the reading position when messages grow and shrink", async () => {
        await anchor();
        const y = top(40);
        for (const index of [10, 60]) {
            for (const change of [350, -350]) {
                messages[index].height += change;
                render();
                await new Promise((resolve) => setTimeout(resolve, 160));
                expect(Math.abs(top(40) - y)).toBeLessThanOrEqual(1);
            }
        }
    });

    it("keeps keyboard paging away from the bottom through updates", async () => {
        const before = node().scrollTop;
        panel.current!.scrollRelative(-1);
        const after = node().scrollTop;
        expect(after).toBeLessThan(before);
        render();
        await frame();
        expect(node().scrollTop).toBeCloseTo(after, 0);
        panel.current!.scrollToBottom();
        render();
        await frame();
        expect(panel.current!.isAtBottom()).toBe(true);
    });

    it("keeps the reading position when the viewport shrinks and expands", async () => {
        await anchor();
        const y = top(40);
        for (const height of [220, 450]) {
            viewportHeight = height;
            render();
            await new Promise((resolve) => setTimeout(resolve, 160));
            expect(Math.abs(top(40) - y)).toBeLessThanOrEqual(1);
        }
    });

    it("does not follow appended messages when sticky bottom is disabled", async () => {
        stickyBottom = false;
        render();
        panel.current!.scrollToBottom();
        await frame();
        const y = top(79);
        messages.push({ id: "event-80", height: 150 });
        render();
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(Math.abs(top(79) - y)).toBeLessThanOrEqual(1);
        expect(panel.current!.getScrollState().stuckAtBottom).toBe(false);
    });
});
