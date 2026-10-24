/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { TooltipProvider } from "@vector-im/compound-web";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import {
    DesktopThreadBrowserView,
    type DesktopThreadBrowserSnapshot,
    type DesktopThreadBrowserActions,
} from "./DesktopThreadBrowserView";
import {
    DesktopThreadCreateView,
    type DesktopThreadCreateSnapshot,
    type DesktopThreadCreateActions,
} from "../DesktopThreadCreateView";
import { MockViewModel } from "../../core/viewmodel";
import { registerTranslations, setLocale } from "../../core/i18n/i18n";
import english from "../../i18n/strings/en_EN.json";

import { I18nApi } from "../../core/i18n/I18nApi";
import { I18nContext } from "../../core/i18n/i18nContext";

import desktopShellCss from "../../../../../apps/web/res/css/structures/_DesktopShell.pcss?raw";
import portuguese from "../../i18n/strings/pt_BR.json";

// These captures render production components with synthetic text. No reference assets or account data are used.
describe("Desktop thread browser layout", () => {
    let container: HTMLDivElement;
    let root: Root;
    let originalBodyClass: string;
    beforeAll(async () => {
        const style = document.createElement("style");
        style.textContent = `@layer compound-tokens, compound-web, shared-components, app-web;
            @layer app-web { ${desktopShellCss} }
            html, body { margin: 0; font-family: Inter, sans-serif; }
            button:focus-visible, textarea:focus-visible { outline: 2px solid var(--cpd-color-border-focused); outline-offset: 2px; }`;
        document.head.appendChild(style);
        await import("./DesktopThreadsLayout.test.css");
        registerTranslations("en", english);
        registerTranslations("pt_BR", portuguese);
        return () => style.remove();
    });
    afterEach(async () => {
        flushSync(() => root?.unmount());
        container?.remove();
        document.body.className = originalBodyClass;
        setLocale("en");
        await page.viewport(960, 720);
    });
    function renderFixture(
        theme: string,
        locale = "en",
        narrow = false,
        extra: Partial<DesktopThreadBrowserSnapshot> = {},
        create = false,
    ): void {
        originalBodyClass = document.body.className;
        document.body.className = `mx_DesktopShell cpd-theme-${theme}`;
        setLocale(locale);
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        const vm = Object.assign(
            new MockViewModel<DesktopThreadBrowserSnapshot>({
                query: "",
                filter: "all",
                rows: [],
                loading: false,
                error: false,
                canCreate: true,
                hasMore: false,
                ...extra,
            }),
            {
                setQuery: vi.fn<DesktopThreadBrowserActions["setQuery"]>(),
                setFilter: vi.fn<DesktopThreadBrowserActions["setFilter"]>(),
                loadMore: vi.fn<DesktopThreadBrowserActions["loadMore"]>(),
                retry: vi.fn<DesktopThreadBrowserActions["retry"]>(),
                openThread: vi.fn<DesktopThreadBrowserActions["openThread"]>(),
                createThread: vi.fn<DesktopThreadBrowserActions["createThread"]>(),
            } satisfies DesktopThreadBrowserActions,
        );
        const createVm = Object.assign(
            new MockViewModel<DesktopThreadCreateSnapshot>({
                starter: "Release planning",
                reply: "Let's ship on Friday.",
                sending: false,
                locked: false,
                starterSent: false,
                error: false,
            }),
            {
                setStarter: vi.fn<DesktopThreadCreateActions["setStarter"]>(),
                setReply: vi.fn<DesktopThreadCreateActions["setReply"]>(),
                submit: vi.fn<DesktopThreadCreateActions["submit"]>(),
                cancel: vi.fn<DesktopThreadCreateActions["cancel"]>(),
            } satisfies DesktopThreadCreateActions,
        );
        flushSync(() =>
            root.render(
                <I18nContext.Provider value={new I18nApi()}>
                    <TooltipProvider>
                        <div
                            style={{
                                width: "100vw",
                                height: "100vh",
                                background: "var(--cpd-color-bg-canvas-default)",
                                color: "var(--cpd-color-text-primary)",
                            }}
                        >
                            {!narrow && (
                                <>
                                    <nav
                                        aria-label="Synthetic channels"
                                        style={{
                                            position: "absolute",
                                            width: 310,
                                            left: 64,
                                            top: 32,
                                            bottom: 0,
                                            background: "var(--mx-desktop-shell-frame)",
                                            padding: 16,
                                            boxSizing: "border-box",
                                        }}
                                    >
                                        Aether workspace
                                        <br />
                                        <br /># general
                                    </nav>
                                    <header
                                        style={{
                                            position: "absolute",
                                            left: 374,
                                            top: 32,
                                            right: 0,
                                            height: 48.83,
                                            padding: "12px 16px",
                                            boxSizing: "border-box",
                                            borderBottom: "1px solid var(--cpd-color-border-interactive-secondary)",
                                        }}
                                    >
                                        # general
                                    </header>
                                    <aside
                                        style={{
                                            position: "absolute",
                                            right: 0,
                                            width: 240,
                                            top: 81,
                                            bottom: 0,
                                            borderInlineStart:
                                                "1px solid var(--cpd-color-border-interactive-secondary)",
                                            padding: 16,
                                            boxSizing: "border-box",
                                        }}
                                    >
                                        Members — 2<br />
                                        <br />
                                        Alex
                                        <br />
                                        <br />
                                        Sam
                                    </aside>
                                    <p style={{ position: "absolute", top: 565, left: 410 }}>
                                        A conversation in the parent channel.
                                    </p>
                                </>
                            )}
                            <div
                                data-testid="browser-fixture"
                                style={{
                                    position: "absolute",
                                    left: narrow ? 8 : 424,
                                    top: narrow ? 16 : 80.83,
                                    maxHeight: narrow ? 608 : 600,
                                }}
                            >
                                {create ? (
                                    <DesktopThreadCreateView vm={createVm} />
                                ) : (
                                    <DesktopThreadBrowserView vm={vm} />
                                )}
                            </div>
                        </div>
                    </TooltipProvider>
                </I18nContext.Provider>,
            ),
        );
    }
    for (const scenario of [
        { name: "dark-empty", theme: "dark" },
        { name: "light-empty", theme: "light" },
        { name: "portuguese-empty", theme: "dark", locale: "pt_BR" },
        { name: "narrow-portuguese", theme: "dark", locale: "pt_BR", narrow: true },
        { name: "long-populated", theme: "dark", populated: true },
        { name: "create", theme: "dark", create: true },
    ]) {
        it(`keeps ${scenario.name} content and controls within the viewport`, async () => {
            await page.viewport(scenario.narrow ? 360 : 1280, scenario.narrow ? 640 : 720);
            renderFixture(
                scenario.theme,
                scenario.locale,
                scenario.narrow,
                scenario.populated
                    ? {
                          rows: [
                              {
                                  id: "$synthetic-root",
                                  title: "Release planning with a very long starter ".repeat(5),
                                  preview: "A synthetic reply ".repeat(15),
                                  replies: 28,
                                  activity: "Oct 23, 17:00",
                                  unread: true,
                              },
                          ],
                          hasMore: true,
                      }
                    : {},
                scenario.create,
            );
            await document.fonts.ready;
            const fixture = page.getByTestId("browser-fixture");
            const bounds = fixture.element().getBoundingClientRect();
            expect(bounds.left).toBeGreaterThanOrEqual(0);
            expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
            expect(bounds.bottom).toBeLessThanOrEqual(document.documentElement.clientHeight);
            expect(bounds.width).toBe(scenario.narrow ? 344 : 480);
            expect(bounds.height).toBeGreaterThan(300);
            const buttons = fixture.element().querySelectorAll("button");
            for (const button of buttons) {
                const rect = button.getBoundingClientRect();
                expect(rect.right).toBeLessThanOrEqual(bounds.right);
            }
            if (import.meta.env.VITE_THREAD_VISUAL_CAPTURE === "true") {
                await page.screenshot({ path: `.vitest/attachments/desktop-threads/${scenario.name}.png` });
                await fixture.screenshot({
                    path: `.vitest/attachments/desktop-threads/${scenario.name}-component.png`,
                });
            }
        });
    }
});
