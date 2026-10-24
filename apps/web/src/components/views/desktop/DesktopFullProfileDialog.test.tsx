/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { Room, RoomMember, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopFullProfileDialog } from "./DesktopFullProfileDialog";
import SettingsStore from "../../../settings/SettingsStore";
import type RightPanelStore from "../../../stores/right-panel/RightPanelStore";

describe("DesktopFullProfileDialog", () => {
    let client: MatrixClient;
    let onFinished: Mock<() => void>;

    beforeEach(() => {
        client = stubClient();
        const room = new Room("!room:example.org", client, client.getSafeUserId());
        const member = new RoomMember(room.roomId, "@robin:example.org");
        member.name = "Robin";
        member.membership = "join";
        vi.spyOn(room, "getMember").mockReturnValue(member);
        vi.mocked(client.getCrypto).mockReturnValue(undefined);
        vi.mocked(client.isGuest).mockReturnValue(false);
        vi.mocked(client.isUserIgnored).mockReturnValue(false);
        client.doesServerSupportMutualRooms = vi.fn().mockResolvedValue(false);
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        onFinished = vi.fn<() => void>();
        render(
            <DesktopFullProfileDialog
                client={client}
                rightPanelStore={{} as RightPanelStore}
                member={member}
                room={room}
                isRoomViewed
                onFinished={onFinished}
            />,
        );
    });
    afterEach(() => vi.restoreAllMocks());

    it("is a labelled modal dialog with the person's profile, and hides mutual rooms the server cannot provide", async () => {
        const dialog = screen.getByRole("dialog", { name: "Profile" });
        expect(dialog).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Robin" })).toBeInTheDocument();
        expect(screen.getByText("@robin:example.org")).toBeInTheDocument();
        await screen.findByRole("tab", { name: "0 mutual spaces" });
        expect(screen.queryByRole("tab", { name: /mutual room/ })).toBeNull();
    });

    it("finishes from its close button", async () => {
        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onFinished).toHaveBeenCalledTimes(1);
    });

    it("finishes from Escape", async () => {
        screen.getByRole("button", { name: "Message" }).focus();
        await userEvent.keyboard("{Escape}");
        expect(onFinished).toHaveBeenCalledTimes(1);
    });
});
