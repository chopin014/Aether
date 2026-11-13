// @vitest-environment happy-dom
/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { EventType, type MatrixClient, MatrixEvent, Room, RoomEvent } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import SpaceSettingsGeneralTab from "./SpaceSettingsGeneralTab";
import DMRoomMap from "../../../utils/DMRoomMap";

const SPACE_ID = "!space:example.org";

describe("SpaceSettingsGeneralTab", () => {
    let client: MatrixClient;
    let space: Room;

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(DMRoomMap, "shared").mockReturnValue({ getUserIdForRoomId: vi.fn() } as unknown as DMRoomMap);
        space = new Room(SPACE_ID, client, client.getSafeUserId());
        space.name = "Garden";
    });

    /** The Space's topic arriving, as it does under sliding sync for a Space that has not been looked at. */
    function topicArrives(topic: string): void {
        act(() => {
            space.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomTopic,
                    state_key: "",
                    content: { topic },
                    room_id: SPACE_ID,
                    sender: "@other:example.org",
                    event_id: `$topic-${topic}`,
                }),
            ]);
        });
    }

    const nameField = (): HTMLElement => screen.getByRole("textbox", { name: "Name" });
    const topicField = (): HTMLElement => screen.getByRole("textbox", { name: "Description" });

    it("shows the topic once it arrives, and saving another change leaves it alone", async () => {
        const user = userEvent.setup();
        render(<SpaceSettingsGeneralTab matrixClient={client} space={space} />);
        expect(topicField()).toHaveValue("");

        topicArrives("Plants");
        expect(topicField()).toHaveValue("Plants");
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true");

        await user.clear(nameField());
        await user.type(nameField(), "Orchard");
        await user.click(screen.getByRole("button", { name: "Save Changes" }));
        await waitFor(() => expect(client.setRoomName).toHaveBeenCalledWith(SPACE_ID, "Orchard"));
        expect(client.setRoomTopic).not.toHaveBeenCalled();
    });

    it("keeps a topic being edited when the Space's arrives", async () => {
        const user = userEvent.setup();
        render(<SpaceSettingsGeneralTab matrixClient={client} space={space} />);
        await user.type(topicField(), "Trees");

        topicArrives("Plants");
        expect(topicField()).toHaveValue("Trees");

        await user.click(screen.getByRole("button", { name: "Save Changes" }));
        await waitFor(() => expect(client.setRoomTopic).toHaveBeenCalledWith(SPACE_ID, "Trees", undefined));
        expect(client.setRoomName).not.toHaveBeenCalled();
    });

    it("follows the Space's name until it is edited, and cancelling follows it again", async () => {
        const user = userEvent.setup();
        render(<SpaceSettingsGeneralTab matrixClient={client} space={space} />);
        expect(nameField()).toHaveValue("Garden");

        act(() => {
            space.name = "Orchard";
            space.emit(RoomEvent.Name, space);
        });
        expect(nameField()).toHaveValue("Orchard");

        await user.type(nameField(), "!");
        act(() => {
            space.name = "Meadow";
            space.emit(RoomEvent.Name, space);
        });
        expect(nameField()).toHaveValue("Orchard!");

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(nameField()).toHaveValue("Meadow");
        expect(vi.mocked(client.setRoomName)).not.toHaveBeenCalled();
    });
});
