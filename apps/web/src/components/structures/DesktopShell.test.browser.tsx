/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Avatar, Badge, Button, Menu, MenuItem, Switch, TooltipProvider } from "@vector-im/compound-web";
import { CheckIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import desktopShellCss from "../../../res/css/structures/_DesktopShell.pcss?raw";
import appIndexCss from "../../../res/css/_index.pcss?raw";

describe("Desktop shell action colours", () => {
    let container: HTMLDivElement;
    let stylesheet: HTMLStyleElement;
    let root: Root;
    let originalBodyClass: string;

    beforeAll(async () => {
        // Declare the production layer order before Vite loads Compound's real CSS and token imports.
        const layers = document.createElement("style");
        layers.textContent = appIndexCss.match(/@layer [^;]+;/)![0];
        document.head.appendChild(layers);
        await import("./DesktopShell.test.css");
        return () => layers.remove();
    });

    beforeEach(() => {
        originalBodyClass = document.body.className;
        document.body.className = "mx_DesktopShell cpd-theme-dark";
        stylesheet = document.createElement("style");
        stylesheet.textContent = `@layer app-web { ${desktopShellCss} }`;
        document.head.appendChild(stylesheet);
        container = document.createElement("div");
        container.style.cssText = "padding: 24px; max-width: 320px;";
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await userEvent.keyboard("[/Space]");
        flushSync(() => root.unmount());
        container.remove();
        stylesheet.remove();
        document.body.className = originalBodyClass;
    });

    function tokenColour(token: string): string {
        const probe = document.createElement("span");
        probe.style.backgroundColor = `var(${token})`;
        container.appendChild(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
    }

    function renderProfile(): void {
        flushSync(() =>
            root.render(
                <section aria-label="Profile" style={{ background: "var(--mx-desktop-shell-frame)" }}>
                    <Badge kind="green">Verified</Badge>
                    <MenuItem role="button" label="Share profile" onSelect={vi.fn<(event: Event) => void>()} />
                    <MenuItem
                        role="button"
                        label="Remove messages"
                        kind="critical"
                        onSelect={vi.fn<(event: Event) => void>()}
                    />
                    <Button kind="secondary">Secondary action</Button>
                    <Button kind="tertiary">Tertiary action</Button>
                </section>,
            ),
        );
    }

    describe("with a colour theme's surfaces", () => {
        const LOW_CONTRAST_THEME = {
            "--ae-surface-raised": "#40444b",
            "--ae-text-muted": "#a3a6aa",
            "--ae-on-accent": "#ffffff",
            "--cpd-color-bg-canvas-default": "#36393f",
        };

        beforeEach(() => {
            for (const [name, value] of Object.entries(LOW_CONTRAST_THEME)) {
                document.body.style.setProperty(name, value);
            }
        });

        afterEach(() => {
            for (const name of Object.keys(LOW_CONTRAST_THEME)) document.body.style.removeProperty(name);
        });

        /** Resolves any CSS colour to its red, green and blue channels, by painting it. */
        function channels(colour: string): number[] {
            const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        }

        function contrast(first: string, second: string): number {
            const luminance = (colour: string): number => {
                const [red, green, blue] = channels(colour).map((channel) => {
                    const value = channel / 255;
                    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
            };
            const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
            return (lighter + 0.05) / (darker + 0.05);
        }

        it.each([
            ["voice recorder icons and waveform", "--cpd-color-gray-600"],
            ["older tertiary icons", "--cpd-color-gray-800"],
        ])("should keep %s readable on the message box", (_name, token) => {
            expect(contrast(tokenColour(token), "#40444b")).toBeGreaterThanOrEqual(3);
        });

        it("should keep a tooltip's text readable while accent fills use white text", () => {
            flushSync(() =>
                root.render(
                    <div
                        // The class Compound's tooltip is given, which the shell's rule matches.
                        className="_tooltip_abc"
                        data-testid="tooltip"
                        style={{
                            background: "var(--cpd-color-alpha-gray-1400)",
                            color: "var(--cpd-color-text-on-solid-primary)",
                        }}
                    >
                        Hide
                    </div>,
                ),
            );
            const { backgroundColor, color } = getComputedStyle(page.getByTestId("tooltip").element());
            expect(contrast(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
            expect(tokenColour("--cpd-color-text-on-solid-primary")).toBe("rgb(255, 255, 255)");
        });
    });

    it.each(["dark", "light"])("should centre server avatar initials in the %s rail", async (theme) => {
        container.className = "mx_MatrixChat_wrapper mx_MatrixChat_desktopShell";
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        for (const selected of [false, true]) {
            flushSync(() =>
                root.render(
                    <nav className="mx_SpacePanel" aria-label="Spaces">
                        <button
                            type="button"
                            className={`mx_SpaceButton_narrow ${selected ? "mx_SpaceButton_active" : ""}`}
                        >
                            <div className="mx_SpaceButton_selectionWrapper">
                                <div className="mx_SpaceButton_avatarWrapper">
                                    <Avatar className="mx_BaseAvatar" id="space" name="Bug" size="32px" type="square" />
                                </div>
                            </div>
                        </button>
                    </nav>,
                ),
            );
            const avatar = container.querySelector<HTMLElement>(".mx_BaseAvatar")!;
            const assertCentred = (): void => {
                const range = document.createRange();
                range.selectNodeContents(avatar);
                const letter = range.getBoundingClientRect();
                const tile = avatar.getBoundingClientRect();
                expect(avatar.textContent).toBe("B");
                expect(tile.width).toBe(48);
                expect(tile.height).toBe(48);
                expect(Math.abs(letter.x + letter.width / 2 - tile.x - tile.width / 2)).toBeLessThan(1);
                expect(Math.abs(letter.y + letter.height / 2 - tile.y - tile.height / 2)).toBeLessThan(1);
            };
            assertCentred();
            await page.getByRole("button").hover();
            assertCentred();
            await page.getByRole("button").unhover();
        }
    });

    it.each(["dark", "light"])("should let portal menu rows share the %s menu surface", (theme) => {
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        flushSync(() =>
            root.render(
                <Menu
                    open
                    onOpenChange={vi.fn<(open: boolean) => void>()}
                    title="Space"
                    trigger={<button type="button">Open space menu</button>}
                >
                    <MenuItem label="New room" onSelect={vi.fn<(event: Event) => void>()} hideChevron />
                    <MenuItem label="Space home" onSelect={vi.fn<(event: Event) => void>()} hideChevron />
                    <MenuItem label="Preferences" onSelect={vi.fn<(event: Event) => void>()} hideChevron />
                </Menu>,
            ),
        );
        const menu = page.getByRole("menu").element();
        expect(container.contains(menu)).toBe(false);
        expect(getComputedStyle(menu).backgroundColor).toBe(tokenColour("--cpd-color-bg-canvas-default"));
        for (const row of menu.querySelectorAll<HTMLElement>("[role=menuitem]")) {
            expect(getComputedStyle(row).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        }
    });

    it.each(["dark", "light"])("should keep profile and button actions on their %s surface", (theme) => {
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        renderProfile();

        expect(getComputedStyle(container.querySelector("section")!).backgroundColor).toBe(
            tokenColour("--mx-desktop-shell-frame"),
        );
        for (const button of container.querySelectorAll("button:not([data-kind=secondary])")) {
            expect(getComputedStyle(button).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        }
        expect(getComputedStyle(page.getByRole("button", { name: "Secondary action" }).element()).backgroundColor).toBe(
            tokenColour("--cpd-color-bg-canvas-default"),
        );
        const criticalLabel = page.getByText("Remove messages").element();
        expect(getComputedStyle(criticalLabel).color).toBe(tokenColour("--cpd-color-text-critical-primary"));
        const verified = page.getByText("Verified").element();
        expect(getComputedStyle(verified).backgroundColor).toBe(tokenColour("--cpd-color-bg-badge-accent"));
        expect(getComputedStyle(verified).color).toBe(tokenColour("--cpd-color-text-badge-accent"));
    });

    it.each(["dark", "light"])("should retain hover, keyboard focus and pressed feedback in %s", async (theme) => {
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        renderProfile();
        const share = page.getByRole("button", { name: "Share profile" });
        await share.hover();
        const hovered = getComputedStyle(share.element()).backgroundColor;
        expect(hovered).toBe(tokenColour("--cpd-color-bg-action-secondary-hovered"));
        expect(hovered).not.toBe("rgba(0, 0, 0, 0)");
        await share.unhover();
        expect(getComputedStyle(share.element()).backgroundColor).toBe("rgba(0, 0, 0, 0)");

        share.element().focus();
        await userEvent.keyboard("[Space>]");
        expect(share.element().matches(":focus-visible")).toBe(true);
        expect(getComputedStyle(share.element()).outlineStyle).not.toBe("none");
        expect(getComputedStyle(share.element()).backgroundColor).toBe(
            tokenColour("--cpd-color-bg-action-secondary-pressed"),
        );
        expect(getComputedStyle(share.element()).backgroundColor).not.toBe(hovered);
        await userEvent.keyboard("[/Space]");

        const remove = page.getByRole("button", { name: "Remove messages" });
        await remove.hover();
        expect(getComputedStyle(remove.element()).backgroundColor).toBe(tokenColour("--cpd-color-bg-critical-subtle"));
    });

    it.each(["dark", "light"])("should preserve the selected switch accent in %s", async (theme) => {
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        flushSync(() =>
            root.render(
                <TooltipProvider>
                    <Switch
                        name="layout"
                        leftIcon={CheckIcon}
                        leftLabel="Grid"
                        leftValue="grid"
                        rightIcon={CheckIcon}
                        rightLabel="List"
                        rightValue="list"
                        value="grid"
                        onChange={vi.fn<(value: string) => void>()}
                    />
                </TooltipProvider>,
            ),
        );
        const selected = container.querySelector<HTMLInputElement>("input:checked")!;
        const unselected = page.getByRole("radio").nth(1);
        expect(getComputedStyle(selected).backgroundColor).toBe(tokenColour("--cpd-color-bg-action-primary-rest"));
        expect(getComputedStyle(unselected.element()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        await unselected.hover();
        await expect
            .poll(() => getComputedStyle(unselected.element()).backgroundColor)
            .toBe(tokenColour("--cpd-color-bg-action-secondary-hovered"));
        expect(getComputedStyle(selected).backgroundColor).toBe(tokenColour("--cpd-color-bg-action-primary-rest"));
    });

    it.each([
        "cpd-theme-dark",
        "cpd-theme-light",
        "mx_DesktopShell cpd-theme-dark-hc",
        "mx_DesktopShell cpd-theme-light-hc",
    ])("should preserve Compound action colours for %s", async (classes) => {
        document.body.className = classes;
        renderProfile();
        const share = page.getByRole("button", { name: "Share profile" });
        const rest = getComputedStyle(share.element()).backgroundColor;
        const text = getComputedStyle(page.getByText("Share profile").element()).color;
        await share.hover();
        const hover = getComputedStyle(share.element()).backgroundColor;
        stylesheet.remove();
        expect(getComputedStyle(share.element()).backgroundColor).toBe(hover);
        expect(getComputedStyle(page.getByText("Share profile").element()).color).toBe(text);
        await share.unhover();
        expect(getComputedStyle(share.element()).backgroundColor).toBe(rest);
        expect(rest).not.toBe("rgba(0, 0, 0, 0)");
    });

    it("should keep host action colours after the call stylesheet loads", async () => {
        renderProfile();
        const share = page.getByRole("button", { name: "Share profile" });
        const rest = getComputedStyle(share.element()).backgroundColor;
        const frame = getComputedStyle(container.querySelector("section")!).backgroundColor;
        await share.hover();
        const hover = getComputedStyle(share.element()).backgroundColor;

        await import("../views/voip/ElementCallComponent.css");

        expect(getComputedStyle(share.element()).backgroundColor).toBe(hover);
        await share.unhover();
        expect(getComputedStyle(share.element()).backgroundColor).toBe(rest);
        expect(getComputedStyle(container.querySelector("section")!).backgroundColor).toBe(frame);
    });
});
