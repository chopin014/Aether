/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { mockPlatformPeg, stubClient } from "test-utils";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import HelpUserSettingsTab from "./HelpUserSettingsTab";
import MatrixClientContext from "../../../../../contexts/MatrixClientContext";
import Modal from "../../../../../Modal";
import QuestionDialog from "../../../dialogs/QuestionDialog";
import PlatformPeg from "../../../../../PlatformPeg";

describe("<HelpUserSettingsTab />", () => {
    let client: MatrixClient;

    beforeEach(() => {
        mockPlatformPeg({
            getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
            canSelfUpdate: vi.fn().mockResolvedValue(false),
        });
        client = stubClient();
        vi.spyOn(client, "getAccessToken").mockReturnValue("syt_secret_access_token");
        vi.spyOn(client, "getCrypto").mockReturnValue(undefined);
        vi.spyOn(client, "getHomeserverUrl").mockReturnValue("https://matrix-client.example.org");
    });

    const renderTab = () =>
        render(
            <MatrixClientContext.Provider value={client}>
                <HelpUserSettingsTab />
            </MatrixClientContext.Provider>,
        );

    it("never shows the access token", () => {
        renderTab();
        expect(screen.queryByText(/syt_secret_access_token/)).not.toBeInTheDocument();
        expect(screen.queryByText("Access Token")).not.toBeInTheDocument();
        expect(client.getAccessToken).not.toHaveBeenCalled();
    });

    it("shows the homeserver the account is on", () => {
        renderTab();
        expect(screen.getByText("https://matrix-client.example.org")).toBeInTheDocument();
    });

    describe("clear cache and reload", () => {
        const confirm = (confirmed: boolean) =>
            vi.spyOn(Modal, "createDialog").mockReturnValue({
                finished: Promise.resolve([confirmed]),
                close: vi.fn(),
            } as any);

        beforeEach(() => {
            client.store.deleteAllData = vi.fn().mockResolvedValue(undefined);
            client.stopClient = vi.fn();
        });

        it("asks before clearing anything", async () => {
            const dialog = confirm(false);
            renderTab();

            await userEvent.click(screen.getByRole("button", { name: "Clear cache and reload" }));

            expect(dialog).toHaveBeenCalledWith(
                QuestionDialog,
                expect.objectContaining({ title: "Clear cache and reload?", danger: true }),
            );
            expect(client.stopClient).not.toHaveBeenCalled();
            expect(client.store.deleteAllData).not.toHaveBeenCalled();
        });

        it("clears the cache and reloads once confirmed", async () => {
            confirm(true);
            const reload = vi.fn();
            PlatformPeg.get()!.reload = reload;
            renderTab();

            await userEvent.click(screen.getByRole("button", { name: "Clear cache and reload" }));

            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(client.stopClient).toHaveBeenCalled();
            expect(client.store.deleteAllData).toHaveBeenCalled();
        });
    });
});
