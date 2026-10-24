/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { TopicDialogViewModel } from "./TopicDialogViewModel";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { RoomSettingsTab } from "../../components/views/dialogs/RoomSettingsDialog-tab";

describe("TopicDialogViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    const onFinished = vi.fn();

    const state = (type: string, content: object): MatrixEvent =>
        new MatrixEvent({ type, state_key: "", room_id: "!r:x", sender: "@a:x", content });

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue("@a:x");
        room = new Room("!r:x", client, "@a:x");
        room.currentState.setStateEvents([state(EventType.RoomTopic, { topic: "Plans" })]);
    });
    afterEach(() => vi.restoreAllMocks());

    it("shows the name and full topic, and follows changes", () => {
        const vm = new TopicDialogViewModel({ room, onFinished });
        expect(vm.getSnapshot()).toMatchObject({ topic: "Plans", canEdit: true, kind: "text" });
        room.currentState.setStateEvents([state(EventType.RoomTopic, { topic: "Later" })]);
        expect(vm.getSnapshot().topic).toBe("Later");
    });

    it("hides editing from those who lack the power", () => {
        room.currentState.setStateEvents([state(EventType.RoomPowerLevels, { state_default: 50 })]);
        expect(new TopicDialogViewModel({ room, onFinished }).getSnapshot().canEdit).toBe(false);
    });

    it("closes the dialog and opens the settings to edit", () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        const vm = new TopicDialogViewModel({ room, onFinished });
        vm.onClose();
        expect(onFinished).toHaveBeenCalledTimes(1);
        vm.onEdit();
        expect(onFinished).toHaveBeenCalledTimes(2);
        expect(dispatch).toHaveBeenCalledWith({
            action: "open_room_settings",
            room_id: "!r:x",
            initial_tab_id: RoomSettingsTab.General,
        });
    });
});
