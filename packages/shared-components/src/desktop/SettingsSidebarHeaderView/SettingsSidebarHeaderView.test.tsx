/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { MockViewModel } from "../../core/viewmodel";
import {
    SettingsSidebarHeaderView,
    type SettingsSidebarHeaderViewActions,
    type SettingsSidebarHeaderViewSnapshot,
} from "./SettingsSidebarHeaderView";

function makeViewModel(
    query = "",
): MockViewModel<SettingsSidebarHeaderViewSnapshot> & SettingsSidebarHeaderViewActions {
    return Object.assign(
        new MockViewModel<SettingsSidebarHeaderViewSnapshot>({
            userId: "@chopin:matrix.org",
            displayName: "chopin",
            query,
        }),
        { editProfile: vi.fn(), setQuery: vi.fn(), openFirstMatch: vi.fn() },
    );
}

describe("SettingsSidebarHeaderView", () => {
    it("shows who is signed in and opens their profile", async () => {
        const vm = makeViewModel();
        render(<SettingsSidebarHeaderView vm={vm} />);

        await userEvent.click(screen.getByRole("button", { name: /chopin/ }));
        expect(vm.editProfile).toHaveBeenCalled();
    });

    it("passes what is typed to the search", async () => {
        const vm = makeViewModel();
        render(<SettingsSidebarHeaderView vm={vm} />);

        await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "a");
        expect(vm.setQuery).toHaveBeenCalledWith("a");
    });

    it("opens the first match on Enter", async () => {
        const vm = makeViewModel("senha");
        render(<SettingsSidebarHeaderView vm={vm} />);

        await userEvent.type(screen.getByRole("searchbox"), "{Enter}");
        expect(vm.openFirstMatch).toHaveBeenCalled();
    });

    it("clears the search on Escape before anything else handles it", async () => {
        const vm = makeViewModel("senha");
        const outer = vi.fn();
        render(
            <div onKeyDown={outer}>
                <SettingsSidebarHeaderView vm={vm} />
            </div>,
        );

        await userEvent.type(screen.getByRole("searchbox"), "{Escape}");
        expect(vm.setQuery).toHaveBeenCalledWith("");
        expect(outer).not.toHaveBeenCalled();
    });
});
