/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopSearchResultsView,
    type DesktopSearchResultRow,
    type DesktopSearchResultsActions,
    type DesktopSearchResultsSnapshot,
} from "./DesktopSearchResultsView";
import { MockViewModel } from "../../core/viewmodel";

const row = (id: string, overrides: Partial<DesktopSearchResultRow> = {}): DesktopSearchResultRow => ({
    id,
    roomId: "!gen:x",
    senderId: "@alice:x",
    senderName: "Alice",
    timeLabel: "Oct 23, 17:00",
    fullTimeLabel: "Friday, 23 October 2026, 17:00",
    segments: [{ text: id, match: false }],
    ...overrides,
});

function makeVm(snapshot: Partial<DesktopSearchResultsSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopSearchResultsSnapshot>({
            status: "ready",
            resultCount: 0,
            countIsLowerBound: false,
            sort: "recent",
            sorts: ["recent", "relevance"],
            groups: [],
            hasMore: false,
            loadingMore: false,
            approximate: false,
            encryptedSkipped: false,
            browseSkipsEncrypted: false,
            activeId: null,
            ...snapshot,
        }),
        {
            setSort: vi.fn(),
            loadMore: vi.fn(),
            retry: vi.fn(),
            openResult: vi.fn(),
            close: vi.fn(),
            openSecuritySettings: vi.fn(),
        } satisfies DesktopSearchResultsActions,
    );
}

describe("DesktopSearchResultsView", () => {
    // The browser would report the end of the list as visible and page on its own.
    beforeEach(() => {
        vi.stubGlobal(
            "IntersectionObserver",
            class {
                public observe = vi.fn();
                public disconnect = vi.fn();
            },
        );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("counts results, with a plus when more may exist", () => {
        const { rerender } = render(<DesktopSearchResultsView vm={makeVm({ resultCount: 1 })} />);
        expect(screen.getByRole("heading", { level: 2, name: "1 result" })).toBeVisible();
        rerender(<DesktopSearchResultsView vm={makeVm({ resultCount: 12 })} />);
        expect(screen.getByRole("heading", { level: 2, name: "12 results" })).toBeVisible();
        rerender(<DesktopSearchResultsView vm={makeVm({ resultCount: 12, countIsLowerBound: true })} />);
        expect(screen.getByRole("heading", { level: 2, name: "12+ results" })).toBeVisible();
    });

    it("groups results by channel and shows the cards", () => {
        const vm = makeVm({
            resultCount: 2,
            groups: [
                { roomId: "!gen:x", roomName: "general", rows: [row("$a")] },
                { roomId: "!dev:x", roomName: "dev", rows: [row("$b", { senderName: "Bob" })] },
            ],
        });
        render(<DesktopSearchResultsView vm={vm} renderAvatar={(r) => <i data-testid={`avatar-${r.id}`} />} />);
        const general = screen.getByRole("region", { name: "general" });
        expect(within(general).getByText("Alice")).toBeVisible();
        expect(within(general).getByTestId("avatar-$a")).toBeInTheDocument();
        expect(within(screen.getByRole("region", { name: "dev" })).getByText("Bob")).toBeVisible();
    });

    it("highlights matching text", () => {
        const vm = makeVm({
            resultCount: 1,
            groups: [
                {
                    roomId: "!gen:x",
                    roomName: "general",
                    rows: [
                        row("$a", {
                            segments: [
                                { text: "the ", match: false },
                                { text: "budget", match: true },
                            ],
                        }),
                    ],
                },
            ],
        });
        render(<DesktopSearchResultsView vm={vm} />);
        expect(screen.getByText("budget").tagName).toBe("MARK");
    });

    it("jumps to a result from the button and from the card, but not from attachment controls", async () => {
        const vm = makeVm({
            resultCount: 1,
            groups: [{ roomId: "!gen:x", roomName: "general", rows: [row("$a", { attachmentName: "doc.pdf" })] }],
        });
        render(<DesktopSearchResultsView vm={vm} renderAttachment={() => <button type="button">Download</button>} />);
        await userEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(vm.openResult).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole("button", { name: "Jump to message from Alice" }));
        expect(vm.openResult).toHaveBeenLastCalledWith("$a");
        await userEvent.click(screen.getByText("$a"));
        expect(vm.openResult).toHaveBeenCalledTimes(2);
    });

    it("switches sort order with tabs, and hides them when only one is available", async () => {
        const vm = makeVm({ resultCount: 1 });
        const { rerender } = render(<DesktopSearchResultsView vm={vm} />);
        expect(screen.getByRole("tab", { name: "Newest" })).toHaveAttribute("aria-selected", "true");
        await userEvent.click(screen.getByRole("tab", { name: "Most relevant" }));
        expect(vm.setSort).toHaveBeenCalledWith("relevance");
        rerender(<DesktopSearchResultsView vm={makeVm({ sorts: ["recent"] })} />);
        expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    });

    it("shows loading, empty, error and idle states", async () => {
        const { rerender } = render(<DesktopSearchResultsView vm={makeVm({ status: "loading" })} />);
        expect(screen.getByRole("status").textContent).toBe("Searching…");

        rerender(<DesktopSearchResultsView vm={makeVm({ status: "ready" })} />);
        expect(screen.getByRole("heading", { name: "No results" })).toBeVisible();

        const failing = makeVm({ status: "error" });
        rerender(<DesktopSearchResultsView vm={failing} />);
        expect(screen.getByRole("alert").textContent).toMatch(/The search failed/);
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(failing.retry).toHaveBeenCalledOnce();

        rerender(<DesktopSearchResultsView vm={makeVm({ status: "idle" })} />);
        expect(screen.getByText("Type something and press Enter to search.")).toBeVisible();
    });

    it("loads more on request and shows progress", async () => {
        const vm = makeVm({
            resultCount: 1,
            hasMore: true,
            groups: [{ roomId: "!gen:x", roomName: "general", rows: [row("$a")] }],
        });
        const { rerender } = render(<DesktopSearchResultsView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Load more results" }));
        expect(vm.loadMore).toHaveBeenCalledOnce();
        rerender(<DesktopSearchResultsView vm={makeVm({ hasMore: true, loadingMore: true })} />);
        expect(screen.getByRole("button", { name: "Loading more…" })).toBeDisabled();
    });

    it("loads the next page when the end scrolls into view", () => {
        let callback: IntersectionObserverCallback = () => {};
        vi.stubGlobal(
            "IntersectionObserver",
            class {
                public constructor(cb: IntersectionObserverCallback) {
                    callback = cb;
                }
                public observe = vi.fn();
                public disconnect = vi.fn();
            },
        );
        const vm = makeVm({ hasMore: true });
        render(<DesktopSearchResultsView vm={vm} />);
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        expect(vm.loadMore).toHaveBeenCalledOnce();
        vi.unstubAllGlobals();
    });

    it("explains approximate filters and skipped encrypted rooms", async () => {
        const vm = makeVm({ approximate: true, encryptedSkipped: true });
        render(<DesktopSearchResultsView vm={vm} />);
        expect(screen.getByText(/counts are approximate/)).toBeVisible();
        expect(screen.getByText(/Encrypted rooms aren't searched/)).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Open Security settings" }));
        expect(vm.openSecuritySettings).toHaveBeenCalledOnce();
    });

    it("mentions that filter-only searches skip encrypted rooms", () => {
        render(<DesktopSearchResultsView vm={makeVm({ browseSkipsEncrypted: true })} />);
        expect(screen.getByText("Searches with only filters skip encrypted rooms.")).toBeVisible();
    });

    it("closes", async () => {
        const vm = makeVm();
        render(<DesktopSearchResultsView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Close search results" }));
        expect(vm.close).toHaveBeenCalledOnce();
    });
});
