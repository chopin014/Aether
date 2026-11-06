/*
Copyright 2026 Gabriel
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, type RenderResult, screen } from "test-utils-rtl";
import { getMockClientWithEventEmitter, mockClientMethodsServer, mockClientMethodsUser } from "test-utils";

import { ChatUserSettingsTab } from "./ChatUserSettingsTab";
import SettingsStore from "../../../../../settings/SettingsStore";
import MatrixClientBackedController from "../../../../../settings/controllers/MatrixClientBackedController";

describe("<ChatUserSettingsTab />", () => {
    const renderTab = (): RenderResult => render(<ChatUserSettingsTab />);

    beforeEach(() => {
        MatrixClientBackedController.matrixClient = getMockClientWithEventEmitter({
            ...mockClientMethodsServer(),
            ...mockClientMethodsUser(),
        });
    });

    it("lists the chat settings in cards", () => {
        const { container } = renderTab();
        const headings = [...container.querySelectorAll(".mx_SettingsSubsection_card")].map(
            (card) =>
                card.closest(".mx_SettingsSubsection")?.querySelector(".mx_SettingsSubsectionHeading_heading")
                    ?.textContent,
        );
        expect(headings).toEqual([
            "Timeline",
            "Composer",
            "Images, GIFs and videos",
            "Link previews",
            "Code blocks",
            "Room list",
            "Servers",
            "Servers to show",
        ]);
    });

    it("offers the timeline and composer settings that used to be under Preferences", () => {
        renderTab();
        expect(
            screen.getByRole("switch", { name: "Show join/leave messages (invites/removes/bans unaffected)" }),
        ).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Enable Markdown" })).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Autoplay GIFs" })).toBeInTheDocument();
    });

    it("offers joining every channel of small servers", () => {
        renderTab();
        expect(screen.getByRole("switch", { name: "Join every channel of small servers" })).toBeInTheDocument();
    });

    describe("bundled url previews only", () => {
        const LABEL = "Only show bundled previews in encrypted rooms";

        afterEach(() => {
            vi.restoreAllMocks();
        });

        // The setting only makes sense alongside the bundle lab flag, so it stays hidden until
        // that flag is on rather than showing a control that cannot do anything.
        it("is not offered when the bundle feature is disabled", () => {
            renderTab();
            expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
        });

        it("is offered when the bundle feature is enabled", () => {
            const original = SettingsStore.getValue;
            vi.spyOn(SettingsStore, "getValue").mockImplementation((setting, ...rest) =>
                setting === "feature_msc4095_url_preview_bundle" ? true : original(setting, ...rest),
            );

            renderTab();
            expect(screen.getByText(LABEL)).toBeInTheDocument();
        });
    });
});
