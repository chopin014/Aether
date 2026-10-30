/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, cleanup } from "@test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { RoomListHeaderView } from "../RoomListHeaderView";
import { MockedViewModel, defaultSnapshot } from "../test-utils";
import { registerTranslations, setLocale } from "../../../core/i18n/i18n";
import pt from "../../../i18n/strings/pt_BR.json";
import desktopShellCss from "../../../../../../apps/web/res/css/structures/_DesktopShell.pcss?raw";
import appIndexCss from "../../../../../../apps/web/res/css/_index.pcss?raw";

const artifacts = "../../../../../../.vitest/server-menu";

describe("Desktop server menu", () => {
    let container: HTMLDivElement;
    let stylesheet: HTMLStyleElement;
    let originalBodyClass: string;

    beforeAll(async () => {
        const layers = document.createElement("style");
        layers.textContent = appIndexCss.match(/@layer [^;]+;/)![0];
        document.head.appendChild(layers);
        await import("../../../../../../apps/web/src/components/structures/DesktopShell.test.css");
        registerTranslations("pt-BR", pt);
        return () => layers.remove();
    });

    beforeEach(async () => {
        await page.viewport(960, 720);
        originalBodyClass = document.body.className;
        stylesheet = document.createElement("style");
        stylesheet.textContent = `@layer app-web { ${desktopShellCss} }`;
        document.head.appendChild(stylesheet);
        container = document.createElement("div");
        container.style.cssText =
            "position: absolute; left: 72px; top: 16px; width: 292px; height: 420px; background: var(--mx-desktop-shell-frame);";
        document.body.appendChild(container);
    });

    afterEach(async () => {
        cleanup();
        container.remove();
        stylesheet.remove();
        document.body.className = originalBodyClass;
        setLocale("en");
        await page.viewport(960, 720);
    });

    function renderHeader(language = "en", title = "Terra do boi gordo"): MockedViewModel {
        setLocale(language);
        const vm = new MockedViewModel({ ...defaultSnapshot, title });
        render(<RoomListHeaderView vm={vm} desktop />, { container });
        return vm;
    }

    function contrast(foreground: string, background: string): number {
        const luminance = (colour: string): number => {
            const channels = colour
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number)
                .map((value) => {
                    const channel = value / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
    }

    async function openMenu(language = "en"): Promise<HTMLElement> {
        await page
            .getByRole("button", { name: language === "en" ? "Open server menu" : "Abrir menu do espaço" })
            .click();
        const menu = page.getByRole("menu");
        await expect.element(menu).toBeVisible();
        await Promise.all(
            menu
                .element()
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished),
        );
        return menu.element() as HTMLElement;
    }

    it.each([
        { theme: "dark", language: "en" },
        { theme: "light", language: "en" },
        { theme: "dark", language: "pt-BR" },
        { theme: "light", language: "pt-BR" },
    ])("should align compact actions and retain contrast in $theme / $language", async ({ theme, language }) => {
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        renderHeader(language);
        const trigger = container.querySelector("button")!.getBoundingClientRect();
        const menu = await openMenu(language);
        const bounds = menu.getBoundingClientRect();
        expect(bounds.left).toBeCloseTo(trigger.left);
        expect(bounds.top - trigger.bottom).toBeCloseTo(8, 0);
        expect(bounds.width).toBe(256);
        expect(bounds.height).toBeLessThan(280);
        expect(menu.textContent).not.toContain("Terra do boi gordo");
        let iconEdge: number | undefined;
        let labelEdge: number | undefined;
        for (const row of menu.querySelectorAll<HTMLElement>("[role=menuitem]")) {
            expect(row.getBoundingClientRect().height).toBe(36);
            const label = row.querySelector("span")!;
            const icon = row.querySelector("svg")!;
            const labelBounds = label.getBoundingClientRect();
            const iconBounds = icon.getBoundingClientRect();
            expect(labelBounds.right).toBeLessThan(iconBounds.left);
            expect(labelBounds.left).toBe(labelEdge ?? labelBounds.left);
            expect(iconBounds.right).toBe(iconEdge ?? iconBounds.right);
            expect(iconBounds.width).toBe(20);
            expect(contrast(getComputedStyle(label).color, getComputedStyle(menu).backgroundColor)).toBeGreaterThan(
                4.5,
            );
            expect(contrast(getComputedStyle(icon).color, getComputedStyle(menu).backgroundColor)).toBeGreaterThan(3);
            labelEdge = labelBounds.left;
            iconEdge = iconBounds.right;
        }
        await page.screenshot({ path: `${artifacts}/after-${theme}${language === "en" ? "" : "-portuguese"}.png` });
    });

    it.each(["dark", "light"])("should preserve keyboard focus and dismiss the %s menu", async (theme) => {
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        const vm = renderHeader();
        const trigger = page.getByRole("button", { name: "Open server menu" });
        trigger.element().focus();
        await userEvent.keyboard("[ArrowDown]");
        const invite = page.getByRole("menuitem", { name: "Invite", exact: true });
        await expect.element(invite).toHaveFocus();
        expect(getComputedStyle(invite.element()).outlineStyle).not.toBe("none");
        expect(getComputedStyle(invite.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
        await userEvent.keyboard("[End]");
        await expect.element(page.getByRole("menuitem", { name: "Server settings" })).toHaveFocus();
        await userEvent.keyboard("[Home]");
        await expect.element(invite).toHaveFocus();
        await userEvent.keyboard("[ArrowDown]");
        await expect.element(page.getByRole("menuitem", { name: "Server home" })).toHaveFocus();
        await userEvent.keyboard("[Escape]");
        await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
        await expect.element(trigger).toHaveFocus();
        await userEvent.keyboard("[ArrowDown]");
        await expect.element(invite).toHaveFocus();
        await userEvent.keyboard("[Enter]");
        expect(vm.inviteInSpace).toHaveBeenCalledOnce();
        await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
        await openMenu();
        await userEvent.click(document.body, { force: true });
        await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    });

    it.each(["dark", "light"])("should give pointer and pressed feedback in %s", async (theme) => {
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        renderHeader();
        await openMenu();
        const home = page.getByRole("menuitem", { name: "Server home" });
        const rest = getComputedStyle(home.element()).backgroundColor;
        await home.hover();
        const hover = getComputedStyle(home.element()).backgroundColor;
        expect(hover).not.toBe(rest);
        const element = home.element();
        // Hold a real pointer press to observe feedback before selecting and dismissing the action.
        const click = home.click({ delay: 500 }).then(() => undefined);
        await expect.poll(() => element.matches(":active")).toBe(true);
        const pressed = getComputedStyle(element).backgroundColor;
        expect(pressed).not.toBe(hover);
        expect(pressed).not.toBe(rest);
        await click;
        await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    });

    it.each(["dark", "light"])("should fit Portuguese actions into a constrained %s viewport", async (theme) => {
        await page.viewport(320, 240);
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        container.style.left = "16px";
        container.style.width = "288px";
        renderHeader("pt-BR", "Terra do boi gordo — comunidade brasileira com nome longo");
        const trigger = page.getByRole("button", { name: "Abrir menu do espaço" });
        const title = trigger.element().querySelector("span")!;
        expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
        expect(title.getAttribute("title")).toBe("Terra do boi gordo — comunidade brasileira com nome longo");
        expect(trigger.element().getBoundingClientRect().right).toBeLessThan(container.getBoundingClientRect().right);
        await trigger.click();
        const menu = page.getByRole("menu").element();
        const bounds = menu.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(8);
        expect(bounds.right).toBeLessThanOrEqual(312);
        expect(bounds.top).toBeGreaterThanOrEqual(8);
        expect(bounds.bottom).toBeLessThanOrEqual(232);
        const scroller = menu.querySelector<HTMLElement>("[role=none]")!;
        expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
        const settings = page.getByRole("menuitem", { name: "Configurações do espaço" });
        await userEvent.keyboard("[End]");
        await expect.element(settings).toHaveFocus();
        expect(scroller.scrollTop).toBeGreaterThan(0);
        for (const row of menu.querySelectorAll<HTMLElement>("[role=menuitem]")) {
            expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
        }
        await Promise.all(menu.getAnimations({ subtree: true }).map((animation) => animation.finished));
        await page.screenshot({ path: `${artifacts}/after-${theme}-portuguese-constrained.png` });
    });
});
