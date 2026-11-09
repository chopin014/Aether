/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { DiscoverView, type DiscoverViewActions, type DiscoverViewSnapshot } from "./DiscoverView";
import { DiscoverNavigationView } from "./DiscoverNavigationView";
import styles from "./DiscoverView.module.css";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DiscoverViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DiscoverViewSnapshot>({
            section: "spaces",
            category: "home",
            query: "",
            server: "example.org",
            servers: [
                { name: "example.org", isHome: true },
                { name: "other.example", isHome: false },
            ],
            entries: [
                {
                    roomId: "!games:example.org",
                    name: "Video Games",
                    topic: "All things games",
                    avatarUrl: "https://example.org/avatar.png",
                    memberCount: 3230,
                    joined: false,
                },
                { roomId: "!home:example.org", name: "Home Space", memberCount: 1, joined: true },
            ],
            status: "ready",
            loadingMore: false,
            hasMore: false,
            ...snapshot,
        }),
        {
            setSection: vi.fn(),
            setCategory: vi.fn(),
            setQuery: vi.fn(),
            setServer: vi.fn(),
            addServer: vi.fn(),
            loadMore: vi.fn(),
            retry: vi.fn(),
            open: vi.fn(),
        } satisfies DiscoverViewActions,
    );
}

describe("DiscoverView", () => {
    it("shows each community with its member count and joined state", () => {
        render(<DiscoverView vm={makeVm()} />);
        const games = screen.getByRole("button", { name: "Video Games" });
        expect(within(games).getByText("All things games")).toBeInTheDocument();
        expect(within(games).getByText("3,230 members")).toBeInTheDocument();
        expect(within(games).queryByText("Joined")).not.toBeInTheDocument();
        const home = screen.getByRole("button", { name: "Home Space" });
        expect(within(home).getByText("1 member")).toBeInTheDocument();
        expect(within(home).getByText("Joined")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Popular servers" })).toBeInTheDocument();
    });

    it("opens a community from its card", async () => {
        const vm = makeVm();
        render(<DiscoverView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Video Games" }));
        expect(vm.open).toHaveBeenCalledWith("!games:example.org");
    });

    it("drops a broken avatar so the card shows initials and colour", () => {
        const { container } = render(<DiscoverView vm={makeVm()} />);
        const banner = container.querySelector<HTMLImageElement>("img[src='https://example.org/avatar.png']")!;
        fireEvent.error(banner);
        expect(container.querySelector("img[src='https://example.org/avatar.png']")).toBeNull();
    });

    it("switches category and searches", async () => {
        const vm = makeVm();
        render(<DiscoverView vm={vm} />);
        const tabs = screen.getByRole("navigation", { name: "Categories" });
        await userEvent.click(within(tabs).getByRole("button", { name: "Music" }));
        expect(vm.setCategory).toHaveBeenCalledWith("music");
        await userEvent.type(screen.getByRole("searchbox", { name: "Search public servers" }), "m");
        expect(vm.setQuery).toHaveBeenCalledWith("m");
    });

    it("names the listing after the search or category", () => {
        const { rerender } = render(<DiscoverView vm={makeVm({ query: " metal " })} />);
        expect(screen.getByRole("heading", { name: "Results for “metal”" })).toBeInTheDocument();
        rerender(<DiscoverView vm={makeVm({ category: "tech" })} />);
        expect(screen.getByRole("heading", { name: "Science & Tech" })).toBeInTheDocument();
        rerender(<DiscoverView vm={makeVm({ section: "rooms" })} />);
        expect(screen.getByRole("heading", { name: "Popular rooms" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Explore public rooms" })).toBeInTheDocument();
    });

    it("offers more results while the directory has them", async () => {
        const vm = makeVm({ hasMore: true });
        render(<DiscoverView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Show more" }));
        expect(vm.loadMore).toHaveBeenCalled();
    });

    it("shows placeholders while loading", () => {
        const { container } = render(<DiscoverView vm={makeVm({ status: "loading", entries: [] })} />);
        expect(container.querySelectorAll("li[aria-hidden]")).toHaveLength(8);
        expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    });

    it("explains an empty search", () => {
        render(<DiscoverView vm={makeVm({ query: "zzz", entries: [] })} />);
        // The title is styled by its own class, which a selector on its position used to stand for.
        expect(screen.getByText("Nothing found for “zzz”")).toHaveClass(styles.stateTitle);
    });

    it("lets the user retry after an error", async () => {
        const vm = makeVm({ status: "error", entries: [] });
        render(<DiscoverView vm={vm} />);
        expect(within(screen.getByRole("alert")).getByText(/example\.org/)).toHaveClass(styles.stateTitle);
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(vm.retry).toHaveBeenCalled();
    });
});

describe("DiscoverNavigationView", () => {
    it("switches between servers and rooms", async () => {
        const vm = makeVm();
        render(<DiscoverNavigationView vm={vm} />);
        expect(screen.getByRole("button", { name: /Servers/ })).toHaveAttribute("aria-current", "page");
        await userEvent.click(screen.getByRole("button", { name: /Rooms/ }));
        expect(vm.setSection).toHaveBeenCalledWith("rooms");
    });

    it("changes and adds directories", async () => {
        const vm = makeVm();
        render(<DiscoverNavigationView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Directory: example.org. Change directory" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "other.example" }));
        expect(vm.setServer).toHaveBeenCalledWith("other.example");
        await userEvent.click(screen.getByRole("button", { name: "Directory: example.org. Change directory" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Add a server…" }));
        expect(vm.addServer).toHaveBeenCalled();
    });
});
