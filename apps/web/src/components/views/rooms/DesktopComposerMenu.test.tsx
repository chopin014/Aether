/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { THREAD_RELATION_TYPE } from "matrix-js-sdk/src/matrix";
import { createTestClient, mkStubRoom } from "test-utils";

import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { RoomUploadContext, type RoomUploadViewModel } from "../../../viewmodels/room/RoomUploadViewModel";
import { DesktopComposerMenu } from "./DesktopComposerMenu";

describe("DesktopComposerMenu", () => {
    const client = createTestClient();
    const room = mkStubRoom("!room:server", "room", client);
    let options: { type: string; label: string }[];
    let onUploadOptionSelected: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        options = [{ type: "local", label: "Attachment" }];
        onUploadOptionSelected = vi.fn();
    });

    function renderMenu(props: Partial<React.ComponentProps<typeof DesktopComposerMenu>> = {}): void {
        // Only the parts of the upload model that the menu reads.
        const snapshot = { options, mayDragAndDropFile: true };
        const vm = {
            getSnapshot: () => snapshot,
            subscribe: () => () => {},
            onUploadOptionSelected,
        } as unknown as RoomUploadViewModel;
        render(
            <MatrixClientContext.Provider value={client}>
                <RoomUploadContext.Provider value={vm}>
                    <DesktopComposerMenu room={room} showPollsButton={true} showLocationButton={false} {...props} />
                </RoomUploadContext.Provider>
            </MatrixClientContext.Provider>,
        );
    }

    it("opens a menu of things to add to the message", async () => {
        renderMenu();

        const button = screen.getByRole("button", { name: "Add to message" });
        expect(button).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(button);

        expect(button).toHaveAttribute("aria-expanded", "true");
        const items = screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"));
        expect(items).toEqual(["Upload file", "Poll"]);
    });

    it("uploads from the menu and closes it", async () => {
        renderMenu();

        await userEvent.click(screen.getByRole("button", { name: "Add to message" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Upload file" }));

        expect(onUploadOptionSelected).toHaveBeenCalledWith("local");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("keeps a module's own upload label", async () => {
        options.push({ type: "cloud", label: "From the cloud" });
        renderMenu({ showPollsButton: false });

        await userEvent.click(screen.getByRole("button", { name: "Add to message" }));

        expect(screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"))).toEqual([
            "Upload file",
            "From the cloud",
        ]);
    });

    it("opens the file picker straight away when uploading is all it offers", async () => {
        // Polls cannot be started in a thread.
        renderMenu({ relation: { rel_type: THREAD_RELATION_TYPE.name, event_id: "$thread" } });

        await userEvent.click(screen.getByRole("button", { name: "Add to message" }));

        expect(onUploadOptionSelected).toHaveBeenCalledWith("local");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("uploads on Ctrl+click without opening the menu", async () => {
        renderMenu();

        const user = userEvent.setup();
        await user.keyboard("{Control>}");
        await user.click(screen.getByRole("button", { name: "Add to message" }));
        await user.keyboard("{/Control}");

        expect(onUploadOptionSelected).toHaveBeenCalledWith("local");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
});
