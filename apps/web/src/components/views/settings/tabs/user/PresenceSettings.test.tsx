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
import { fireEvent, render, waitFor } from "test-utils-rtl";
import { stubClient } from "test-utils";

import { PresenceSettings } from "./PresenceSettings";
import { MatrixClientPeg } from "../../../../../MatrixClientPeg";
import SettingsStore from "../../../../../settings/SettingsStore";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import MatrixClientBackedController from "../../../../../settings/controllers/MatrixClientBackedController";
import { type SettingKey } from "../../../../../settings/Settings.tsx";

describe("<PresenceSettings />", () => {
    describe("send read receipts", () => {
        beforeEach(() => {
            stubClient();
            vi.spyOn(SettingsStore, "setValue");
            vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
        });

        afterEach(() => {
            vi.resetAllMocks();
        });

        const getToggle = () => render(<PresenceSettings />).getByRole("switch", { name: "Send read receipts" });

        const mockIsVersionSupported = (val: boolean) => {
            const client = MatrixClientPeg.safeGet();
            vi.spyOn(client, "doesServerSupportUnstableFeature").mockResolvedValue(false);
            vi.spyOn(client, "isVersionSupported").mockImplementation(async (version: string) => {
                if (version === "v1.4") return val;
                return false;
            });
            MatrixClientBackedController.matrixClient = client;
        };

        const mockGetValue = (val: boolean) => {
            const copyOfGetValueAt = SettingsStore.getValueAt;

            SettingsStore.getValueAt = (
                level: SettingLevel,
                name: SettingKey,
                roomId?: string,
                isExplicit?: boolean,
            ) => {
                if (name === "sendReadReceipts") return val;
                return copyOfGetValueAt(level, name, roomId, isExplicit);
            };
        };

        const expectSetValueToHaveBeenCalled = (
            name: string,
            roomId: string | null,
            level: SettingLevel,
            value: boolean,
        ) => expect(SettingsStore.setValue).toHaveBeenCalledWith(name, roomId, level, value);

        describe("with server support", () => {
            beforeEach(() => {
                mockIsVersionSupported(true);
            });

            it("can be enabled", async () => {
                mockGetValue(false);
                const toggle = getToggle();

                await waitFor(() => expect(toggle).not.toBeDisabled());
                fireEvent.click(toggle);
                expectSetValueToHaveBeenCalled("sendReadReceipts", null, SettingLevel.ACCOUNT, true);
            });

            it("can be disabled", async () => {
                mockGetValue(true);
                const toggle = getToggle();

                await waitFor(() => expect(toggle).not.toBeDisabled());
                fireEvent.click(toggle);
                expectSetValueToHaveBeenCalled("sendReadReceipts", null, SettingLevel.ACCOUNT, false);
            });
        });

        describe("without server support", () => {
            beforeEach(() => {
                mockIsVersionSupported(false);
            });

            it("is forcibly enabled", async () => {
                const toggle = getToggle();
                await waitFor(() => {
                    expect(toggle).toBeChecked();
                    expect(toggle).toBeDisabled();
                });
            });

            it("cannot be disabled", async () => {
                mockGetValue(true);
                const toggle = getToggle();

                await waitFor(() => expect(toggle).toBeDisabled());
                console.log(toggle.innerHTML);
                fireEvent.click(toggle);
                expect(SettingsStore.setValue).not.toHaveBeenCalled();
            });
        });
    });
});
