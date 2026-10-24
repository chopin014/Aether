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
    DesktopSearchBoxView,
    type DesktopSearchBoxActions,
    type DesktopSearchBoxSnapshot,
} from "./DesktopSearchBoxView";
import { MockViewModel } from "../../core/viewmodel";

const filterSections: DesktopSearchBoxSnapshot["sections"] = [
    {
        id: "filters",
        options: (["from", "in", "has", "mentions", "more"] as const).map((filter) => ({
            id: `filter:${filter}`,
            kind: "filter" as const,
            filter,
        })),
    },
];

function makeVm(snapshot: Partial<DesktopSearchBoxSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopSearchBoxSnapshot>({
            scopeName: "Guizika",
            text: "",
            chips: [],
            open: true,
            sections: filterSections,
            activeId: null,
            focusRequest: 0,
            ...snapshot,
        }),
        {
            setText: vi.fn(),
            setOpen: vi.fn(),
            removeChip: vi.fn(),
            removeLastChip: vi.fn(),
            activate: vi.fn(),
            moveActive: vi.fn(),
            submit: vi.fn(),
            clear: vi.fn(),
            dismiss: vi.fn(),
            clearSection: vi.fn(),
        } satisfies DesktopSearchBoxActions,
    );
}

describe("DesktopSearchBoxView", () => {
    it("names the scope in the placeholder and exposes a combobox", () => {
        render(<DesktopSearchBoxView vm={makeVm()} />);
        const input = screen.getByRole("combobox", { name: "Search" });
        expect(input).toHaveAttribute("placeholder", "Search Guizika");
        expect(input).toHaveAttribute("aria-expanded", "true");
        expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    });

    it("keeps the field and popup outside the native window drag region", () => {
        render(<DesktopSearchBoxView vm={makeVm()} />);
        const input = screen.getByRole("combobox", { name: "Search" });
        const root = input.parentElement!.parentElement!;
        const popup = screen.getByRole("listbox", { name: "Search filters" }).parentElement!;
        expect(getComputedStyle(root).getPropertyValue("-webkit-app-region")).toBe("no-drag");
        expect(getComputedStyle(popup).getPropertyValue("-webkit-app-region")).toBe("no-drag");
    });

    it("lists the Discord-style filters in a labelled listbox", () => {
        render(<DesktopSearchBoxView vm={makeVm()} />);
        const list = screen.getByRole("listbox", { name: "Search filters" });
        const group = within(list).getByRole("group", { name: "Filters" });
        expect(within(group).getAllByRole("option")).toHaveLength(5);
        expect(within(group).getByRole("option", { name: /From a specific user/ })).toBeVisible();
        expect(within(group).getByRole("option", { name: /Sent in a specific channel/ })).toBeVisible();
        expect(within(group).getByRole("option", { name: /Mentions a specific user/ })).toBeVisible();
    });

    it("hides the popover when closed", () => {
        render(<DesktopSearchBoxView vm={makeVm({ open: false })} />);
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
    });

    it("opens when focused", async () => {
        const vm = makeVm({ open: false });
        render(<DesktopSearchBoxView vm={vm} />);
        await userEvent.click(screen.getByRole("combobox"));
        expect(vm.setOpen).toHaveBeenCalledWith(true);
    });

    it("points aria-activedescendant at the highlighted option", () => {
        render(<DesktopSearchBoxView vm={makeVm({ activeId: "filter:in" })} />);
        const active = screen.getByRole("option", { name: /Sent in a specific channel/ });
        expect(active).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("combobox")).toHaveAttribute("aria-activedescendant", active.id);
        expect(screen.getByRole("option", { name: /From a specific user/ })).toHaveAttribute("aria-selected", "false");
    });

    it("moves with the arrow keys, submits with Enter and dismisses with Escape", async () => {
        const vm = makeVm();
        render(<DesktopSearchBoxView vm={vm} />);
        screen.getByRole("combobox").focus();
        await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
        expect(vm.moveActive.mock.calls).toEqual([["next"], ["next"], ["previous"]]);
        await userEvent.keyboard("{Enter}");
        expect(vm.submit).toHaveBeenCalledOnce();
        await userEvent.keyboard("{Escape}");
        expect(vm.dismiss).toHaveBeenCalledOnce();
    });

    it("opens the popover with the arrow keys when it is closed", async () => {
        const vm = makeVm({ open: false });
        render(<DesktopSearchBoxView vm={vm} />);
        screen.getByRole("combobox").focus();
        vm.setOpen.mockClear();
        await userEvent.keyboard("{ArrowDown}");
        expect(vm.setOpen).toHaveBeenCalledWith(true);
        expect(vm.moveActive).not.toHaveBeenCalled();
    });

    it("activates an option when clicked", async () => {
        const vm = makeVm();
        render(<DesktopSearchBoxView vm={vm} />);
        await userEvent.click(screen.getByRole("option", { name: /Includes a specific type/ }));
        expect(vm.activate).toHaveBeenCalledWith("filter:has");
    });

    it("forwards typing", async () => {
        const vm = makeVm();
        render(<DesktopSearchBoxView vm={vm} />);
        await userEvent.type(screen.getByRole("combobox"), "a");
        expect(vm.setText).toHaveBeenCalledWith("a");
    });

    describe("chips", () => {
        const chips = [
            { id: "from:@a:x", filter: "from" as const, value: "Alice" },
            { id: "has:file", filter: "has" as const, value: "file" },
        ];

        it("shows removable chips and drops the placeholder", async () => {
            const vm = makeVm({ chips });
            render(<DesktopSearchBoxView vm={vm} />);
            expect(screen.getByText("Alice")).toBeVisible();
            expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "");
            await userEvent.click(screen.getByRole("button", { name: "Remove filter has:file" }));
            expect(vm.removeChip).toHaveBeenCalledWith("has:file");
        });

        it("removes the last chip with Backspace at the start of an empty input", async () => {
            const vm = makeVm({ chips });
            render(<DesktopSearchBoxView vm={vm} />);
            screen.getByRole("combobox").focus();
            await userEvent.keyboard("{Backspace}");
            expect(vm.removeLastChip).toHaveBeenCalledOnce();
        });

        it("keeps Backspace for editing when there is text before the caret", async () => {
            const vm = makeVm({ chips, text: "ab" });
            render(<DesktopSearchBoxView vm={vm} />);
            screen.getByRole("combobox").focus();
            await userEvent.keyboard("{Backspace}");
            expect(vm.removeLastChip).not.toHaveBeenCalled();
        });

        it("clears everything with the clear button", async () => {
            const vm = makeVm({ chips });
            render(<DesktopSearchBoxView vm={vm} />);
            await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
            expect(vm.clear).toHaveBeenCalledOnce();
        });

        it("offers no clear button for an empty search", () => {
            render(<DesktopSearchBoxView vm={makeVm()} />);
            expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
        });
    });

    it("shows suggestions for a value with their names and hints", () => {
        render(
            <DesktopSearchBoxView
                vm={makeVm({
                    sections: [
                        {
                            id: "members",
                            options: [
                                { id: "from:@a:x", kind: "choice", filter: "from", title: "Alice", subtitle: "@a:x" },
                            ],
                        },
                        {
                            id: "has",
                            options: [{ id: "has:file", kind: "choice", filter: "has", titleKey: "has_file" }],
                        },
                        { id: "dates", options: [{ id: "hint", kind: "hint", filter: "before" }] },
                    ],
                })}
            />,
        );
        expect(screen.getByRole("option", { name: /Alice/ })).toBeVisible();
        expect(screen.getByRole("option", { name: "Attachment or file" })).toBeVisible();
        expect(screen.getByText("Type a date as YYYY-MM-DD")).toBeVisible();
        expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    it("lists recent searches and clears them", async () => {
        const vm = makeVm({
            sections: [
                {
                    id: "recent",
                    clearable: true,
                    options: [
                        {
                            id: "recent:0",
                            kind: "recent",
                            text: "budget",
                            chips: [{ id: "has:file", filter: "has", value: "file" }],
                        },
                    ],
                },
            ],
        });
        render(<DesktopSearchBoxView vm={vm} />);
        expect(screen.getByRole("option", { name: "has:file budget" })).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Clear" }));
        expect(vm.clearSection).toHaveBeenCalledWith("recent");
    });

    it("shows a message when nothing matches", () => {
        render(<DesktopSearchBoxView vm={makeVm({ sections: [{ id: "members", options: [] }] })} />);
        expect(screen.getByText("No matches")).toBeVisible();
    });

    it("moves focus into the input when asked", () => {
        const vm = makeVm({ focusRequest: 0 });
        const { rerender } = render(<DesktopSearchBoxView vm={vm} />);
        expect(screen.getByRole("combobox")).not.toHaveFocus();
        const asked = makeVm({ focusRequest: 1 });
        rerender(<DesktopSearchBoxView vm={asked} />);
        expect(screen.getByRole("combobox")).toHaveFocus();
    });
});
