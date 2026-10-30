/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { composeStories } from "@storybook/react-vite";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import * as stories from "./DesktopAccountDockView.stories";
import { DesktopAccountDockView } from "./DesktopAccountDockView";
import { BaseViewModel, MockViewModel } from "../../core/viewmodel";
import { type UserMenuViewSnapshot, type UserMenuViewActions } from "../../menus/UserMenu/UserMenu";
import { type SetStatusViewSnapshot } from "../../status/SetStatusView";

class AccountViewModel extends BaseViewModel<UserMenuViewSnapshot, void> implements UserMenuViewActions {
    public constructor(
        actions: UserMenuViewSnapshot["actions"] = { editProfile: true, openSettings: true, openSecurity: true },
    ) {
        super(undefined, {
            open: false,
            expanded: true,
            displayName: "Alice",
            userId: "@alice:example.org",
            showAvatar: true,
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
    public editProfile = vi.fn();
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
    it("follows speech and gives soundboard playback priority on the account avatar", () => {
        const { InVoiceCall } = composeStories(stories);
        const voice = InVoiceCall.args.voice!;
        const { container, rerender } = render(<InVoiceCall voice={{ ...voice, speaking: true }} />);
        expect(container.querySelector("[data-voice-activity]")).toHaveAttribute("data-voice-activity", "speaking");
        rerender(<InVoiceCall voice={{ ...voice, speaking: true, soundboardPlaying: true }} />);
        expect(container.querySelector("[data-voice-activity]")).toHaveAttribute("data-voice-activity", "soundboard");
        rerender(<InVoiceCall voice={voice} />);
        expect(container.querySelector("[data-voice-activity]")).toBeNull();
    });

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

    it("edits the profile from the menu item and from the avatar above it", async () => {
        const vm = new AccountViewModel();
        render(<DesktopAccountDockView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "User menu" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Edit profile" }));
        expect(vm.editProfile).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "User menu" }));
        await userEvent.click(screen.getByRole("button", { name: "Edit profile" }));
        expect(vm.editProfile).toHaveBeenCalledTimes(2);
    });

    it("respects an account that does not expose settings", () => {
        render(<DesktopAccountDockView vm={new AccountViewModel({})} />);
        expect(screen.queryByRole("button", { name: "All settings" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "User menu" })).toBeVisible();
    });
});
