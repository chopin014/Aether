/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { act, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { EventType, type MatrixClient, MatrixEvent, Room, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { mkStubRoom, stubClient } from "test-utils";

import RoomProfileSettings from "./RoomProfileSettings";
import DMRoomMap from "../../../utils/DMRoomMap";

const BASE64_GIF = "R0lGODlhAQABAAAAACw=";
const AVATAR_FILE = new File([Uint8Array.from(atob(BASE64_GIF), (c) => c.charCodeAt(0))], "avatar.gif", {
    type: "image/gif",
});

const ROOM_ID = "!floob:itty";

describe("RoomProfileSetting", () => {
    let client: MatrixClient;
    let room: Room;

    beforeEach(() => {
        const dmRoomMap = {
            getUserIdForRoomId: vi.fn(),
        } as unknown as DMRoomMap;
        vi.spyOn(DMRoomMap, "shared").mockReturnValue(dmRoomMap);

        client = stubClient();
        room = mkStubRoom(ROOM_ID, "Test room", client);
    });

    it("handles uploading a room avatar", async () => {
        const user = userEvent.setup();
        vi.mocked(client.uploadContent).mockResolvedValue({ content_uri: "mxc://matrix.org/1234" });

        render(<RoomProfileSettings roomId={ROOM_ID} />);

        await user.upload(screen.getByAltText("Upload"), AVATAR_FILE);

        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(client.uploadContent).toHaveBeenCalledWith(AVATAR_FILE));
        await waitFor(() =>
            expect(client.sendStateEvent).toHaveBeenCalledWith(
                ROOM_ID,
                EventType.RoomAvatar,
                {
                    url: "mxc://matrix.org/1234",
                },
                "",
            ),
        );
    });

    it("removes a room avatar", async () => {
        const user = userEvent.setup();

        vi.mocked(client).getRoom.mockReturnValue(room);
        vi.spyOn(room.currentState, "getStateEvents").mockImplementation(
            // @ts-ignore
            (type: string): MatrixEvent[] | MatrixEvent | null => {
                if (type === EventType.RoomAvatar) {
                    // @ts-ignore
                    return { getContent: () => ({ url: "mxc://matrix.org/1234" }) };
                }
                return null;
            },
        );

        render(<RoomProfileSettings roomId="!floob:itty" />);

        await user.click(screen.getByRole("button", { name: "Room avatar" }));
        await user.click(screen.getByRole("menuitem", { name: "Remove" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() =>
            expect(client.sendStateEvent).toHaveBeenCalledWith("!floob:itty", EventType.RoomAvatar, {}, ""),
        );
    });

    it("cancels changes", async () => {
        const user = userEvent.setup();

        render(<RoomProfileSettings roomId="!floob:itty" />);

        const roomNameInput = screen.getByLabelText("Room Name");
        expect(roomNameInput).toHaveValue("");

        await user.type(roomNameInput, "My Room");
        expect(roomNameInput).toHaveValue("My Room");

        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(roomNameInput).toHaveValue("");
    });

    describe("when the room's state arrives after the settings open", () => {
        // Under sliding sync, a room someone has not opened has no name or topic state until its subscription is
        // answered.
        let liveRoom: Room;

        beforeEach(() => {
            liveRoom = new Room(ROOM_ID, client, client.getSafeUserId());
            vi.mocked(client.getRoom).mockReturnValue(liveRoom);
        });

        function arrive(type: EventType, content: object): void {
            const event = new MatrixEvent({
                type,
                state_key: "",
                content,
                room_id: ROOM_ID,
                sender: "@other:itty",
                event_id: `$${type}`,
            });
            act(() => {
                liveRoom.currentState.setStateEvents([event]);
                client.emit(RoomStateEvent.Events, event, liveRoom.currentState, null);
            });
        }

        it("shows the room's name and topic", () => {
            render(<RoomProfileSettings roomId={ROOM_ID} />);
            expect(screen.getByLabelText("Room Name")).toHaveValue("");
            expect(screen.getByLabelText("Room Topic")).toHaveValue("");

            arrive(EventType.RoomName, { name: "Garden" });
            arrive(EventType.RoomTopic, { topic: "Plants" });

            expect(screen.getByLabelText("Room Name")).toHaveValue("Garden");
            expect(screen.getByLabelText("Room Topic")).toHaveValue("Plants");
            expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
        });

        it("keeps what someone has typed, and saves only that", async () => {
            const user = userEvent.setup();
            render(<RoomProfileSettings roomId={ROOM_ID} />);
            await user.type(screen.getByLabelText("Room Topic"), "Trees");

            arrive(EventType.RoomName, { name: "Garden" });
            arrive(EventType.RoomTopic, { topic: "Plants" });

            expect(screen.getByLabelText("Room Name")).toHaveValue("Garden");
            expect(screen.getByLabelText("Room Topic")).toHaveValue("Trees");
            await user.click(screen.getByRole("button", { name: "Save" }));
            await waitFor(() => expect(client.setRoomTopic).toHaveBeenCalledWith(ROOM_ID, "Trees", undefined));
            expect(client.setRoomName).not.toHaveBeenCalled();
        });

        it("ignores other rooms and stops listening once closed", () => {
            const removeListener = vi.spyOn(client, "removeListener");
            const { unmount } = render(<RoomProfileSettings roomId={ROOM_ID} />);
            const event = new MatrixEvent({
                type: EventType.RoomTopic,
                state_key: "",
                content: { topic: "Elsewhere" },
                room_id: "!other:itty",
                sender: "@other:itty",
                event_id: "$elsewhere",
            });
            act(() => {
                client.emit(RoomStateEvent.Events, event, liveRoom.currentState, null);
            });
            expect(screen.getByLabelText("Room Topic")).toHaveValue("");

            unmount();
            expect(removeListener).toHaveBeenCalledWith(RoomStateEvent.Events, expect.any(Function));
        });
    });
});
