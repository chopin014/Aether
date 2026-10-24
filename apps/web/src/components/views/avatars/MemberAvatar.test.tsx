/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest";
import { getByTestId, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { type MatrixClient, PendingEventOrdering, Room, RoomMember } from "matrix-js-sdk/src/matrix";
import React, { type ComponentProps } from "react";
import { getRoomContext } from "test-utils/room";
import { stubClient } from "test-utils/test-utils";

import MemberAvatar from "./MemberAvatar";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import SettingsStore from "../../../settings/SettingsStore";
import { ScopedRoomContextProvider } from "../../../contexts/ScopedRoomContext.tsx";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";

describe("MemberAvatar", () => {
    const ROOM_ID = "roomId";

    let mockClient: MatrixClient;
    let room: Room;
    let member: RoomMember;

    function getComponent(props: Partial<ComponentProps<typeof MemberAvatar>>) {
        return (
            <ScopedRoomContextProvider {...getRoomContext(room, {})}>
                <MemberAvatar member={null} size="35px" {...props} />
            </ScopedRoomContextProvider>
        );
    }

    beforeEach(() => {
        vi.clearAllMocks();

        stubClient();
        mockClient = vi.mocked(MatrixClientPeg.safeGet());

        room = new Room(ROOM_ID, mockClient, mockClient.getUserId() ?? "", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });

        member = new RoomMember(ROOM_ID, "@bob:example.org");
        vi.spyOn(room, "getMember").mockReturnValue(member);
        vi.spyOn(member, "getMxcAvatarUrl").mockReturnValue("http://placekitten.com/400/400");
    });

    it("shows an avatar for useOnlyCurrentProfiles", async () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation((settingName: string) => {
            return settingName === "useOnlyCurrentProfiles";
        });

        const { container } = render(getComponent({}));

        let avatar: HTMLElement;
        await waitFor(() => {
            avatar = getByTestId(container, "avatar-img");
            expect(avatar).toBeInTheDocument();
        });

        expect(avatar!.getAttribute("src")).not.toBe("");
    });

    it("asks to view the member when a timeline author's avatar is clicked", async () => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => undefined);
        render(getComponent({ member, viewUserOnClick: true }));
        await userEvent.click(await screen.findByRole("button"));
        expect(dispatch).toHaveBeenCalledWith({ action: Action.ViewUser, member, push: false });
    });
});
