/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, type RenderResult, screen, waitFor } from "test-utils-rtl";
import {
    getMockClientWithEventEmitter,
    mockClientMethodsServer,
    mockClientMethodsUser,
    mockPlatformPeg,
} from "test-utils";
import userEvent from "@testing-library/user-event";

import { LanguageTimeUserSettingsTab } from "./LanguageTimeUserSettingsTab";
import SettingsStore from "../../../../../settings/SettingsStore";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import MatrixClientBackedController from "../../../../../settings/controllers/MatrixClientBackedController";
import PlatformPeg from "../../../../../PlatformPeg";

describe("LanguageTimeUserSettingsTab", () => {
    beforeEach(() => {
        mockPlatformPeg();
    });

    const renderTab = (): RenderResult => {
        return render(<LanguageTimeUserSettingsTab />);
    };

    it("should render", () => {
        MatrixClientBackedController.matrixClient = getMockClientWithEventEmitter({
            ...mockClientMethodsServer(),
            ...mockClientMethodsUser(),
        });
        const { asFragment } = renderTab();
        expect(asFragment()).toMatchSnapshot();
    });

    it("should reload when changing language", async () => {
        const reloadStub = vi.fn();
        PlatformPeg.get()!.reload = reloadStub;

        renderTab();
        const languageDropdown = await screen.findByRole("button", { name: "Language Dropdown" });
        expect(languageDropdown).toBeInTheDocument();

        await userEvent.click(languageDropdown);

        const germanOption = await screen.findByText("Deutsch");
        await userEvent.click(germanOption);
        await waitFor(() => expect(reloadStub).toHaveBeenCalled());
    });

    it("should save the preference and update the desktop language before reloading", async () => {
        const saved = Promise.withResolvers<void>();
        const localized = Promise.withResolvers<void>();
        const save = vi.spyOn(SettingsStore, "setValue").mockReturnValue(saved.promise);
        const platform = PlatformPeg.get()!;
        const setLanguage = vi.spyOn(platform, "setLanguage").mockReturnValue(localized.promise);
        const reload = vi.fn();
        platform.reload = reload;

        try {
            renderTab();
            await userEvent.click(await screen.findByRole("button", { name: "Language Dropdown" }));
            await userEvent.click(await screen.findByText("Deutsch"));

            expect(save).toHaveBeenCalledWith("language", null, SettingLevel.DEVICE, "de");
            expect(setLanguage).not.toHaveBeenCalled();
            expect(reload).not.toHaveBeenCalled();

            saved.resolve();
            await waitFor(() => expect(setLanguage).toHaveBeenCalledWith(["de"]));
            expect(reload).not.toHaveBeenCalled();

            localized.resolve();
            await waitFor(() => expect(reload).toHaveBeenCalledOnce());
        } finally {
            save.mockRestore();
            setLanguage.mockRestore();
        }
    });

    it("should search and select a user timezone", async () => {
        renderTab();

        expect(await screen.findByText(/Browser default/)).toBeInTheDocument();
        const timezoneDropdown = await screen.findByRole("button", { name: "Set timezone" });
        await userEvent.click(timezoneDropdown);

        // Without filtering `expect(screen.queryByRole("option" ...` take over 1s.
        await fireEvent.change(screen.getByRole("combobox", { name: "Set timezone" }), {
            target: { value: "Africa/Abidjan" },
        });

        expect(screen.queryByRole("option", { name: "Africa/Abidjan" })).toBeInTheDocument();
        expect(screen.queryByRole("option", { name: "Europe/Paris" })).not.toBeInTheDocument();

        await fireEvent.change(screen.getByRole("combobox", { name: "Set timezone" }), {
            target: { value: "Europe/Paris" },
        });

        expect(screen.queryByRole("option", { name: "Africa/Abidjan" })).not.toBeInTheDocument();
        const option = await screen.getByRole("option", { name: "Europe/Paris" });
        await userEvent.click(option);

        expect(await screen.findByText("Europe/Paris")).toBeInTheDocument();
    });

    it("should not show spell check setting if unsupported", async () => {
        PlatformPeg.get()!.supportsSpellCheckSettings = vi.fn().mockReturnValue(false);

        renderTab();
        expect(screen.queryByRole("switch", { name: "Allow spell check" })).not.toBeInTheDocument();
    });

    it("should enable spell check", async () => {
        const spellCheckEnableFn = vi.fn();
        PlatformPeg.get()!.supportsSpellCheckSettings = vi.fn().mockReturnValue(true);
        PlatformPeg.get()!.getSpellCheckEnabled = vi.fn().mockReturnValue(false);
        PlatformPeg.get()!.setSpellCheckEnabled = spellCheckEnableFn;

        renderTab();
        const toggle = await screen.findByRole("switch", { name: "Allow spell check" });
        expect(toggle).not.toBeDisabled();

        await userEvent.click(toggle);

        expect(spellCheckEnableFn).toHaveBeenCalledWith(true);
    });
});
