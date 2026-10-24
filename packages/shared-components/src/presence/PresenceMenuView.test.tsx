/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent as browserUserEvent } from "vitest/browser";
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
import { type DesktopVoiceControlsViewSnapshot } from "../desktop/DesktopVoiceControlsView";
import { registerTranslations, setLocale } from "../core/i18n/i18n";
import pt from "../i18n/strings/pt_BR.json";
import desktopShellCss from "../../../../apps/web/res/css/structures/_DesktopShell.pcss?raw";
import appIndexCss from "../../../../apps/web/res/css/_index.pcss?raw";

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

function voiceModel() {
    return Object.assign(
        new MockViewModel<DesktopVoiceControlsViewSnapshot>({
            microphoneMuted: true,
            deafened: true,
            videoEnabled: false,
            screenShareAvailable: false,
            screenSharing: false,
            busy: false,
        }),
        {
            toggleMicrophone: vi.fn().mockResolvedValue(undefined),
            toggleDeafened: vi.fn().mockResolvedValue(undefined),
            toggleVideo: vi.fn().mockResolvedValue(undefined),
            toggleScreenShare: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockResolvedValue(undefined),
            showCall: vi.fn(),
        },
    );
}

describe("PresenceMenuView in the account dock", () => {
    beforeAll(async () => {
        const stylesheet = document.createElement("style");
        stylesheet.textContent = `${appIndexCss.match(/@layer [^;]+;/)![0]} @layer app-web { ${desktopShellCss} }`;
        document.head.appendChild(stylesheet);
        await import("../../../../apps/web/src/components/structures/DesktopShell.test.css");
        registerTranslations("pt-BR", pt);
        return () => stylesheet.remove();
    });

    afterEach(() => {
        document.body.classList.remove("cpd-theme-dark", "cpd-theme-light", "mx_DesktopShell");
        setLocale("en");
    });

    it.each([
        { preference: "online" as const, label: "Online" },
        { preference: "unavailable" as const, label: "Away" },
        { preference: "offline" as const, label: "Appear offline" },
    ])("should always show the selected $label dot without server presence", ({ preference, label }) => {
        const { getByRole } = render(<DesktopAccountDockView vm={new AccountModel(presenceModel({ preference }))} />);
        const dot = getByRole("img", { name: label });
        expect(dot).toBeVisible();
        expect(dot).toHaveAttribute("title", `${label} · Your selected status; server status unavailable.`);
        const badge = dot.getBoundingClientRect();
        const avatar = dot.parentElement!.getBoundingClientRect();
        // The ringed dot sits just past the avatar's corner, like Discord's cutout, without drifting away from it.
        expect(badge.right - avatar.right).toBe(2);
        expect(badge.bottom - avatar.bottom).toBe(2);
        expect(getComputedStyle(dot).paddingTop).toBe("3px");
        expect(badge.width).toBeGreaterThanOrEqual(12);
    });

    it("should retain a neutral indicator when presence is disabled", () => {
        const { getByRole } = render(
            <DesktopAccountDockView vm={new AccountModel(presenceModel({ enabled: false }))} />,
        );
        expect(getByRole("img", { name: "Presence disabled" })).toBeVisible();
    });

    it.each([
        { preference: "online" as const, current: "unavailable" as const, label: "Away" },
        { preference: "offline" as const, current: "online" as const, label: "Appear offline" },
        { preference: "unavailable" as const, current: "online" as const, label: "Away" },
    ])("should respect $preference when the server reports $current", ({ preference, current, label }) => {
        const { getByRole } = render(
            <DesktopAccountDockView vm={new AccountModel(presenceModel({ preference, current }))} />,
        );
        expect(getByRole("img", { name: label })).toBeVisible();
    });

    it.each([
        { desired: "unavailable" as const, current: undefined, label: "Away" },
        { desired: "online" as const, current: "unavailable" as const, label: "Online" },
        { desired: "offline" as const, current: "online" as const, label: "Appear offline" },
    ])("should show local $desired intent in the account dock", ({ desired, current, label }) => {
        const { getByRole, getByText } = render(
            <DesktopAccountDockView vm={new AccountModel(presenceModel({ desired, current }))} />,
        );
        expect(getByRole("img", { name: label })).toBeVisible();
        expect(getByText(label)).toBeVisible();
    });

    it("should reveal the Matrix ID on hover and keyboard focus without shifting the identity", async () => {
        const { getByRole, getByText } = render(
            <DesktopAccountDockView vm={new AccountModel(presenceModel({ preference: "online" }))} />,
        );
        const trigger = getByRole("button", { name: "User menu" });
        const status = getByText("Online");
        const id = getByText("@gabriel:example.org");
        const locator = page.getByRole("button", { name: "User menu", exact: true });
        await locator.unhover();
        trigger.blur();
        expect(status).toBeVisible();
        expect(id).not.toBeVisible();
        const before = trigger.getBoundingClientRect();
        await locator.hover();
        expect(status).not.toBeVisible();
        expect(id).toBeVisible();
        expect(trigger.getBoundingClientRect().toJSON()).toEqual(before.toJSON());
        expect(getByRole("img", { name: "Online" })).toBeVisible();
        await locator.unhover();
        expect(status).toBeVisible();
        getByRole("button", { name: "All settings" }).focus();
        await browserUserEvent.keyboard("{Shift>}{Tab}{/Shift}");
        expect(trigger).toHaveFocus();
        expect(id).toBeVisible();
    });

    it.each(["dark", "light"])(
        "should retain the badge and voice controls on a narrow Portuguese dock in %s",
        async (theme) => {
            await page.viewport(400, 720);
            document.body.classList.add(`cpd-theme-${theme}`, "mx_DesktopShell");
            setLocale("pt-BR");
            const { getByRole, getByText } = render(
                <div style={{ position: "fixed", left: 8, bottom: 8, width: 384 }}>
                    <DesktopAccountDockView
                        vm={new AccountModel(presenceModel({ preference: "online" }))}
                        voice={voiceModel()}
                    />
                </div>,
            );
            const dot = getByRole("img", { name: "Disponível" });
            const trigger = dot.closest("button")!;
            const dock = trigger.closest('[role="group"]')!;
            expect(dot).toBeVisible();
            expect(getByText("Disponível")).toBeVisible();
            expect(dock.getBoundingClientRect().right).toBeLessThanOrEqual(400);
            if (import.meta.env.VITE_CAPTURE_PRESENCE) {
                await page.screenshot({ path: `../../../../.artifacts/presence-dock-${theme}-pt.png` });
            }
            await page.elementLocator(trigger).hover();
            expect(getByText("@gabriel:example.org")).toBeVisible();
            expect(dot).toBeVisible();
            for (const control of dock.querySelectorAll("button")) {
                expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(400);
            }
            if (import.meta.env.VITE_CAPTURE_PRESENCE) {
                await page.screenshot({ path: `../../../../.artifacts/presence-dock-${theme}-pt-hover.png` });
            }
        },
    );

    it.each(["dark", "light"])("should open the profile status submenu by keyboard in %s theme", async (theme) => {
        await page.viewport(1100, 800);
        document.body.classList.add(`cpd-theme-${theme}`, "mx_DesktopShell");
        const presence = presenceModel();
        const vm = new AccountModel(presence);
        const { getByRole, findByRole, queryByText } = render(
            <div style={{ position: "fixed", left: 24, bottom: 24, width: 370 }}>
                <DesktopAccountDockView vm={vm} voice={voiceModel()} />
            </div>,
        );
        const trigger = getByRole("button", { name: "User menu" });
        trigger.focus();
        await userEvent.keyboard("{Enter}");
        getByRole("menuitem", { name: "Appear offline" }).focus();
        await userEvent.keyboard("{ArrowRight}");
        const away = await findByRole("menuitemradio", { name: "Away" });
        expect(queryByText("Status unknown")).toBeNull();
        expect(queryByText(/^Requested:/)).toBeNull();
        expect(getByRole("menuitemradio", { name: "Appear offline" })).toHaveAttribute("aria-checked", "true");
        const colors = ["Online", "Away", "Appear offline"].map(
            (name) => getComputedStyle(getByRole("menuitemradio", { name }).querySelector("svg")!).color,
        );
        expect(new Set(colors).size).toBe(3);
        const submenu = away.closest('[role="menu"]')!.getBoundingClientRect();
        expect(submenu.width).toBeLessThanOrEqual(260);
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
