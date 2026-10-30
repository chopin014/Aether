// @vitest-environment jsdom
/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { SpaceTagSettings } from "./SpaceTagSettings";
import { SPACE_TAG_EVENT_TYPE } from "../../../profile/spaceTag";
import SettingsStore from "../../../settings/SettingsStore";

const SPACE = "!space:example.org";

function makeSpace(canEdit: boolean, tag?: Record<string, unknown>): Room {
    return {
        roomId: SPACE,
        name: "English Server",
        currentState: {
            maySendStateEvent: () => canEdit,
            getStateEvents: () => (tag ? { getContent: () => tag } : null),
        },
    } as unknown as Room;
}

describe("SpaceTagSettings", () => {
    let client: MatrixClient;

    beforeEach(() => {
        client = {
            getSafeUserId: () => "@me:example.org",
            sendStateEvent: vi.fn().mockResolvedValue({}),
        } as unknown as MatrixClient;
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            ((name: string) => name === "feature_desktop_shell") as typeof SettingsStore.getValue,
        );
    });

    it("is absent outside the desktop shell", () => {
        vi.mocked(SettingsStore.getValue).mockReturnValue(false);
        const { container } = render(<SpaceTagSettings matrixClient={client} space={makeSpace(true)} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("is absent for people who cannot edit a Space with no tag", () => {
        const { container } = render(<SpaceTagSettings matrixClient={client} space={makeSpace(false)} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("shows a member the existing tag without letting them change it", () => {
        render(<SpaceTagSettings matrixClient={client} space={makeSpace(false, { label: "ENG" })} />);
        expect(screen.getByRole("textbox", { name: "Tag" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    });

    it("saves a tag to the Space's state", async () => {
        render(<SpaceTagSettings matrixClient={client} space={makeSpace(true)} />);
        expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
        await userEvent.type(screen.getByRole("textbox", { name: "Tag" }), "ENG");
        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            SPACE,
            SPACE_TAG_EVENT_TYPE,
            expect.objectContaining({ label: "ENG" }),
            "",
        );
    });

    it("removes a tag, and reports a failure", async () => {
        vi.mocked(client.sendStateEvent).mockRejectedValue(new Error("no"));
        render(<SpaceTagSettings matrixClient={client} space={makeSpace(true, { label: "ENG" })} />);
        await userEvent.click(screen.getByRole("button", { name: "Remove" }));
        expect(client.sendStateEvent).toHaveBeenCalledWith(SPACE, SPACE_TAG_EVENT_TYPE, {}, "");
        await waitFor(() => expect(screen.getByText("The tag could not be saved.")).toBeInTheDocument());
    });
});
