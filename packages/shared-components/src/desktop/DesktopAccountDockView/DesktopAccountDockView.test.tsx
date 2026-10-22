/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { DesktopAccountDockView } from "./DesktopAccountDockView";
import { BaseViewModel, MockViewModel } from "../../core/viewmodel";
import { type UserMenuViewSnapshot, type UserMenuViewActions } from "../../menus/UserMenu/UserMenu";
import { type SetStatusViewSnapshot } from "../../status/SetStatusView";

class AccountViewModel extends BaseViewModel<UserMenuViewSnapshot, void> implements UserMenuViewActions {
    public constructor(actions: UserMenuViewSnapshot["actions"] = { openSettings: true, openSecurity: true }) {
        super(undefined, {
            open: false,
            expanded: true,
            displayName: "Alice",
            userId: "@alice:example.org",
            actions,
            setStatusViewModel: Object.assign(new MockViewModel<SetStatusViewSnapshot>({}), {
                setStatus: vi.fn(),
                clearStatus: vi.fn(),
            }),
        });
    }
    public setOpen = (open: boolean): void => {
        this.snapshot.merge({ open });
    };
    public setIdentity = (displayName: string, userId: string): void => {
        this.snapshot.merge({ displayName, userId });
    };
    public createAccount = vi.fn();
    public signIn = vi.fn();
    public linkNewDevice = vi.fn();
    public openFeedback = vi.fn();
    public openHomePage = vi.fn();
    public openSecurity = vi.fn();
    public openSettings = vi.fn();
    public clearStatus = vi.fn();
}

describe("DesktopAccountDockView", () => {
    it("updates the visible Matrix identity when the account model changes", () => {
        const vm = new AccountViewModel();
        render(<DesktopAccountDockView vm={vm} />);
        expect(screen.getByText("@alice:example.org")).toBeVisible();
        act(() => vm.setIdentity("Alice Cooper", "@alice:other.example.org"));
        expect(screen.getByText("Alice Cooper")).toBeVisible();
        expect(screen.getByText("@alice:other.example.org")).toBeVisible();
    });

    it("opens settings through the existing account action", async () => {
        const vm = new AccountViewModel();
        render(<DesktopAccountDockView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "All settings" }));
        expect(vm.openSettings).toHaveBeenCalledOnce();
    });

    it("retains the security menu and returns keyboard focus after Escape", async () => {
        const vm = new AccountViewModel();
        render(<DesktopAccountDockView vm={vm} />);
        const trigger = screen.getByRole("button", { name: "User menu" });
        trigger.focus();
        await userEvent.keyboard("{Enter}");
        await userEvent.click(screen.getByRole("menuitem", { name: "Security & Privacy" }));
        expect(vm.openSecurity).toHaveBeenCalledOnce();
        await userEvent.click(trigger);
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it("respects an account that does not expose settings", () => {
        render(<DesktopAccountDockView vm={new AccountViewModel({})} />);
        expect(screen.queryByRole("button", { name: "All settings" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "User menu" })).toBeVisible();
    });
});
