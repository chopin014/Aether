/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopThreadBrowserView,
    type DesktopThreadBrowserSnapshot,
    type DesktopThreadBrowserActions,
} from "./DesktopThreadBrowserView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DesktopThreadBrowserSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopThreadBrowserSnapshot>({
            query: "",
            filter: "all",
            loading: false,
            error: false,
            hasMore: false,
            canCreate: true,
            rows: [],
            ...snapshot,
        }),
        {
            setQuery: vi.fn(),
            setFilter: vi.fn(),
            loadMore: vi.fn(),
            retry: vi.fn(),
            openThread: vi.fn(),
            createThread: vi.fn(),
        } satisfies DesktopThreadBrowserActions,
    );
}

describe("DesktopThreadBrowserView", () => {
    it("focuses search and offers creation from the empty state without sending a message", async () => {
        const vm = makeVm();
        render(<DesktopThreadBrowserView vm={vm} />);
        expect(screen.getByRole("searchbox", { name: "Search threads" })).toHaveFocus();
        expect(screen.getByRole("heading", { name: "There are no threads." })).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Create thread" }));
        expect(vm.createThread).toHaveBeenCalledOnce();
        expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });
    it("shows actual rows and forwards discovery, filtering and paging actions", async () => {
        const vm = makeVm({
            hasMore: true,
            rows: [
                {
                    id: "$root",
                    title: "Release planning",
                    preview: "We can ship on Friday",
                    replies: 2,
                    unread: true,
                    activity: "Oct 23, 17:00",
                },
            ],
        });
        render(<DesktopThreadBrowserView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: /Release planning/ }));
        expect(vm.openThread).toHaveBeenCalledWith("$root");
        expect(screen.getByLabelText("Unread")).toBeInTheDocument();
        const nav = screen.getByRole("navigation", { name: "Threads" });
        await userEvent.click(within(nav).getByRole("button", { name: "My threads" }));
        expect(vm.setFilter).toHaveBeenCalledWith("mine");
        await userEvent.type(screen.getByRole("searchbox"), "p");
        expect(vm.setQuery).toHaveBeenCalledWith("p");
        await userEvent.click(screen.getByRole("button", { name: "Load more threads" }));
        expect(vm.loadMore).toHaveBeenCalledOnce();
        expect(
            screen.getByText("Search covers loaded threads. Load more to search older conversations."),
        ).toBeVisible();
    });
    it("distinguishes search misses from an empty channel and respects creation permissions", () => {
        render(<DesktopThreadBrowserView vm={makeVm({ query: "missing", canCreate: false })} />);
        expect(screen.getByRole("heading", { name: "No matching threads" })).toBeVisible();
        expect(screen.queryByRole("button", { name: /Create/ })).not.toBeInTheDocument();
    });
    it("offers retry after a failed load and disables duplicate pagination while loading", async () => {
        const vm = makeVm({ error: true });
        render(<DesktopThreadBrowserView vm={vm} />);
        expect(screen.getByRole("alert").textContent).toContain("Threads could not be loaded");
        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(vm.retry).toHaveBeenCalledOnce();
    });
    it("shows loading independently of empty content", () => {
        render(<DesktopThreadBrowserView vm={makeVm({ loading: true, hasMore: true })} />);
        expect(screen.getByRole("status").textContent).toContain("Loading");
        expect(screen.queryByText("There are no threads.")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Load more threads" })).toBeDisabled();
    });
});
