/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import userEvent from "@testing-library/user-event";
import { render } from "@test-utils";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "../../.storybook/compound.css";

import { BaseViewModel, MockViewModel } from "../core/viewmodel";
import { type PresenceSnapshot, type PresenceViewModel } from "./PresenceMenuView";
import { DesktopAccountDockView } from "../desktop/DesktopAccountDockView";
import { type UserMenuViewSnapshot, type UserMenuViewActions } from "../menus/UserMenu/UserMenu";
import { type SetStatusViewSnapshot } from "../status/SetStatusView";

class AccountModel extends BaseViewModel<UserMenuViewSnapshot, void> implements UserMenuViewActions {
    public constructor(presence: PresenceViewModel) {
        super(undefined, {
            open: false,
            expanded: true,
            displayName: "Gabriel",
            userId: "@gabriel:example.org",
            showAvatar: true,
            showUserStatus: false,
            presence,
            actions: { editProfile: true, openSettings: true, openSecurity: true },
            setStatusViewModel: Object.assign(new MockViewModel<SetStatusViewSnapshot>({}), {
                setStatus: vi.fn(),
                clearStatus: vi.fn(),
            }),
        });
    }
    public setOpen = (open: boolean): void => {
        this.snapshot.merge({ open });
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

function presenceModel(snapshot: Partial<PresenceSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<PresenceSnapshot>({
            enabled: true,
            preference: "offline",
            busy: false,
            ...snapshot,
        }),
        { setPreference: vi.fn().mockResolvedValue(undefined), retry: vi.fn().mockResolvedValue(undefined) },
    );
}

describe("PresenceMenuView in the account dock", () => {
    afterEach(() => {
        document.body.classList.remove("cpd-theme-dark", "cpd-theme-light");
    });

    it("should omit a dock presence dot until the server supplies a status", () => {
        const { queryByRole, getByText } = render(<DesktopAccountDockView vm={new AccountModel(presenceModel())} />);
        expect(getByText("@gabriel:example.org")).toBeVisible();
        expect(queryByRole("img", { name: "Offline" })).toBeNull();
    });

    it("should show an accessible dot for actual received offline presence", () => {
        const { getByRole } = render(
            <DesktopAccountDockView vm={new AccountModel(presenceModel({ current: "offline" }))} />,
        );
        expect(getByRole("img", { name: "Offline" })).toBeVisible();
    });

    it.each(["dark", "light"])("should open the profile status submenu by keyboard in %s theme", async (theme) => {
        await page.viewport(1100, 800);
        document.body.classList.add(`cpd-theme-${theme}`);
        const presence = presenceModel();
        const vm = new AccountModel(presence);
        const { getByRole, findByRole, getByText } = render(
            <div style={{ position: "fixed", left: 24, bottom: 24, width: 370 }}>
                <DesktopAccountDockView vm={vm} />
            </div>,
        );
        const trigger = getByRole("button", { name: "User menu" });
        trigger.focus();
        await userEvent.keyboard("{Enter}");
        getByRole("menuitem", { name: "Requested: Appear offline" }).focus();
        await userEvent.keyboard("{ArrowRight}");
        const away = await findByRole("menuitemradio", { name: "Away" });
        expect(getByText("Status unknown")).toBeVisible();
        expect(getByRole("menuitemradio", { name: "Appear offline" })).toHaveAttribute("aria-checked", "true");
        if (import.meta.env.VITE_CAPTURE_PRESENCE) {
            await document.fonts.ready;
            await Promise.all(document.getAnimations().map((animation) => animation.finished));
            await page.screenshot({ path: `../../../../.artifacts/presence-${theme}.png` });
        }
        await userEvent.click(away);
        expect(presence.setPreference).toHaveBeenCalledWith("unavailable");
        await userEvent.keyboard("{Escape}{Escape}");
        expect(trigger).toHaveFocus();
        vm.dispose();
    });
});
