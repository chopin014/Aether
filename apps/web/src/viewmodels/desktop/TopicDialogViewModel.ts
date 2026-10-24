/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type TopicDialogViewActions,
    type TopicDialogViewSnapshot,
} from "@element-hq/web-shared-components";
import { EventType, RoomEvent, RoomStateEvent, type Room } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { RoomSettingsTab } from "../../components/views/dialogs/RoomSettingsDialog-tab";
import { getTopic } from "../../hooks/room/useTopic";

interface Props {
    room: Room;
    /** Closes the dialog. */
    onFinished: () => void;
}

/** The full topic of a channel, with an Edit entry for people who may change it. */
export class TopicDialogViewModel
    extends BaseViewModel<TopicDialogViewSnapshot, Props>
    implements TopicDialogViewActions
{
    public constructor(props: Props) {
        super(props, TopicDialogViewModel.compute(props.room));
        this.disposables.trackListener(props.room, RoomEvent.Name, this.refresh);
        this.disposables.trackListener(props.room.currentState, RoomStateEvent.Events, this.refresh);
    }

    private static compute(room: Room): TopicDialogViewSnapshot {
        return {
            name: room.name,
            kind: room.isCallRoom() || room.isElementVideoRoom() ? "voice" : "text",
            topic: getTopic(room)?.text ?? "",
            canEdit: room.currentState.maySendStateEvent(EventType.RoomTopic, room.client.getSafeUserId()),
        };
    }

    private refresh = (): void => {
        this.snapshot.merge(TopicDialogViewModel.compute(this.props.room));
    };

    public onClose = (): void => this.props.onFinished();

    public onEdit = (): void => {
        this.props.onFinished();
        defaultDispatcher.dispatch({
            action: "open_room_settings",
            room_id: this.props.room.roomId,
            initial_tab_id: RoomSettingsTab.General,
        });
    };
}
