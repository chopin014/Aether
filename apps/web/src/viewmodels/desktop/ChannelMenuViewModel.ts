/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type ChannelMenuViewActions,
    type ChannelMenuViewSnapshot,
    type RoomListItemViewActions,
    type RoomListItemViewSnapshot,
    type ViewModel,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";
import { EventType, RoomEvent, RoomStateEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type FocusMessageSearchPayload } from "../../dispatcher/payloads/FocusMessageSearchPayload";
import Modal from "../../Modal";
import ExportDialog from "../../components/views/dialogs/ExportDialog";
import { PollHistoryDialog } from "../../components/views/dialogs/PollHistoryDialog";
import { ReportRoomDialog } from "../../components/views/dialogs/ReportRoomDialog";
import { RoomSettingsTab } from "../../components/views/dialogs/RoomSettingsDialog-tab";
import RightPanelStore from "../../stores/right-panel/RightPanelStore";
import { RightPanelPhases } from "../../stores/right-panel/RightPanelStorePhases";
import type SpaceStore from "../../stores/spaces/SpaceStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { RoomPermalinkCreator } from "../../utils/permalinks/Permalinks";
import { isVideoRoom } from "../../utils/video-rooms";
import { getTopic } from "../../hooks/room/useTopic";
import { DeleteChannelDialog } from "../../components/views/dialogs/DeleteChannelDialog";
import { canDeleteChannel } from "../../utils/room/canDeleteChannel";
import { hasCreateRoomRights } from "../room-list/utils";

/** The part of a room list item's view model that the channel menu reuses for its Matrix actions. */
export type ChannelMenuItemSource = ViewModel<
    RoomListItemViewSnapshot,
    Pick<
        RoomListItemViewActions,
        | "onMarkAsRead"
        | "onToggleFavorite"
        | "onInvite"
        | "onCopyRoomLink"
        | "onSetRoomNotifState"
        | "onLeaveRoom"
        | "onEditChannel"
    >
>;

interface Props {
    room: Room;
    client: MatrixClient;
    /** The room list item view model for this room, which already owns favourites, notifications and leaving. */
    item: ChannelMenuItemSource;
    /** Where the "Create text channel" entry looks for the active Space. */
    spaceStore?: Pick<SpaceStore, "activeSpaceRoom" | "isRoomInSpace">;
}

/**
 * The Discord-style channel menu shared by the room header and the room list's context menu.
 * It derives which entries apply from the room and the room list item, and sends each choice through the
 * existing Matrix flow (settings dialog, invite, leave confirmation, export, report, poll history).
 */
export class ChannelMenuViewModel
    extends BaseViewModel<ChannelMenuViewSnapshot, Props>
    implements ChannelMenuViewActions
{
    public constructor(props: Props) {
        super(props, ChannelMenuViewModel.compute(props));
        this.disposables.track(props.item.subscribe(this.refresh));
        this.disposables.trackListener(props.room, RoomEvent.Name, this.refresh);
        this.disposables.trackListener(props.room.currentState, RoomStateEvent.Events, this.refresh);
        this.disposables.trackListener(props.room.currentState, RoomStateEvent.Members, this.refresh);
        const space = (props.spaceStore ?? SDKContextClass.instance.spaceStore).activeSpaceRoom;
        if (space) this.disposables.trackListener(space.currentState, RoomStateEvent.Events, this.refresh);
        if (!props.room.membersLoaded()) {
            void props.room
                .loadMembersIfNeeded()
                .then(this.refresh)
                .catch((error) => {
                    logger.warn("Unable to check channel deletion permissions", error);
                });
        }
    }

    private static compute({
        room,
        client,
        item,
        spaceStore = SDKContextClass.instance.spaceStore,
    }: Props): ChannelMenuViewSnapshot {
        const source = item.getSnapshot();
        const userId = client.getSafeUserId();
        const activeSpace = spaceStore.activeSpaceRoom;
        const inActiveSpace = !!activeSpace && spaceStore.isRoomInSpace(activeSpace.roomId, room.roomId);
        return {
            name: room.name,
            kind: source.channelKind ?? (room.isCallRoom() || room.isElementVideoRoom() ? "voice" : "text"),
            iconUrl: source.channelIconUrl,
            topic: getTopic(room)?.text || undefined,
            canEditTopic: room.currentState.maySendStateEvent(EventType.RoomTopic, userId),
            isEncrypted: client.isRoomEncrypted(room.roomId),
            historyVisibility: room.currentState.getHistoryVisibility(),
            hasMessages: !isVideoRoom(room),
            canMarkAsRead: source.canMarkAsRead,
            isFavourite: source.isFavourite,
            canInvite: source.canInvite,
            canCopyLink: source.canCopyRoomLink,
            canChangeNotifications: source.showNotificationMenu,
            roomNotifState: source.roomNotifState,
            canEditChannel: room.currentState.maySendStateEvent(EventType.RoomName, userId),
            canCreateChannel: inActiveSpace && hasCreateRoomRights(client, activeSpace),
            canDeleteChannel: room.membersLoaded() && canDeleteChannel(room, activeSpace, userId),
        };
    }

    private refresh = (): void => {
        this.snapshot.merge(ChannelMenuViewModel.compute(this.props));
    };

    public onMarkAsRead = (): void => this.props.item.onMarkAsRead();
    public onToggleFavourite = (): void => this.props.item.onToggleFavorite();
    public onInvite = (): void => this.props.item.onInvite();
    public onCopyLink = (): void => this.props.item.onCopyRoomLink();
    public onSetNotifState: ChannelMenuViewActions["onSetNotifState"] = (state) =>
        this.props.item.onSetRoomNotifState(state);
    public onEditChannel = (): void => this.props.item.onEditChannel?.();
    public onLeave = (): void => this.props.item.onLeaveRoom();

    public onDelete = (): void => {
        const space = (this.props.spaceStore ?? SDKContextClass.instance.spaceStore).activeSpaceRoom;
        if (!space || !canDeleteChannel(this.props.room, space, this.props.client.getSafeUserId())) return;
        Modal.createDialog(
            DeleteChannelDialog,
            { room: this.props.room, space, client: this.props.client },
            undefined,
            false,
            true,
        );
    };

    public onEditTopic = (): void => this.openSettings(RoomSettingsTab.General);
    public onOpenSecuritySettings = (): void => this.openSettings(RoomSettingsTab.Security);

    private openSettings(initialTabId: RoomSettingsTab): void {
        defaultDispatcher.dispatch({
            action: "open_room_settings",
            room_id: this.props.room.roomId,
            initial_tab_id: initialTabId,
        });
    }

    public onCreateChannel = (): void => {
        const parentSpace = (this.props.spaceStore ?? SDKContextClass.instance.spaceStore).activeSpaceRoom;
        if (parentSpace) defaultDispatcher.dispatch({ action: Action.CreateRoom, parent_space: parentSpace });
    };

    /** Files are a search for messages that carry a file; the search view owns the results. */
    public onFiles = (): void => {
        defaultDispatcher.dispatch<FocusMessageSearchPayload>({
            action: Action.FocusMessageSearch,
            initialText: "has:file",
        });
    };

    public onPolls = (): void => {
        const permalinkCreator = new RoomPermalinkCreator(this.props.room);
        permalinkCreator.start();
        void Modal.createDialog(PollHistoryDialog, {
            room: this.props.room,
            matrixClient: this.props.client,
            permalinkCreator,
        }).finished.then(() => permalinkCreator.stop());
    };

    /** Extensions are content, so they stay a card in the right column. */
    public onExtensions = (): void => {
        RightPanelStore.instance.setCard({ phase: RightPanelPhases.Extensions });
    };

    public onExport = (): void => {
        Modal.createDialog(ExportDialog, { room: this.props.room });
    };

    public onReport = async (): Promise<void> => {
        const [leave] = await Modal.createDialog(ReportRoomDialog, { roomId: this.props.room.roomId }).finished;
        if (leave) this.props.item.onLeaveRoom();
    };
}
