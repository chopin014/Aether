/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type ServerMenuViewActions,
    type ServerMenuViewSnapshot,
    type ServerNotificationLevel,
} from "@element-hq/web-shared-components";
import {
    EventType,
    JoinRule,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    RoomEvent,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import SettingsStore from "../../settings/SettingsStore";
import { NotificationLevel } from "../../stores/notifications/NotificationLevel";
import { NotificationStateEvents } from "../../stores/notifications/NotificationState";
import {
    getServerMute,
    getServerNotificationLevel,
    markServerAsRead,
    muteServer,
    SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE,
    setServerNotificationLevel,
    unmuteServer,
} from "../../stores/notifications/ServerNotifications";
import { TimedMutes, TimedMutesEvent } from "../../stores/notifications/TimedMutes";
import { SpaceLayoutStore, SpaceLayoutStoreEvent } from "../../stores/space-layout/SpaceLayoutStore";
import type SpaceStore from "../../stores/spaces/SpaceStore";
import { leaveSpace } from "../../utils/leave-behaviour";
import { shouldShowSpaceSettings, showCreateNewRoom, showSpaceInvite, showSpaceSettings } from "../../utils/space";
import { hasCreateRoomRights } from "../room-list/utils";
import { reportLayoutError, showCreateCategory } from "../room-list/serverCategories";
import { showServerNicknameDialog } from "../../components/views/desktop/DesktopServerNicknameDialog";

interface Props {
    /** The server whose menu this is. */
    space: Room;
    client: MatrixClient;
    spaceStore: Pick<SpaceStore, "getNotificationState">;
}

/**
 * A server's menu in the server rail, as in Discord: marking the server as read, inviting, muting it, its
 * notifications and muted channels, its settings, creating channels and categories, and leaving it. It is made while
 * the menu is open, and follows changes to the server meanwhile.
 */
export class ServerMenuViewModel extends BaseViewModel<ServerMenuViewSnapshot, Props> implements ServerMenuViewActions {
    /** Wakes the menu up when the server's mute ends, to offer muting again. */
    private muteEndTimer?: ReturnType<typeof setTimeout>;

    public constructor(props: Props) {
        super(props, ServerMenuViewModel.compute(props));
        const { space, client, spaceStore } = props;
        this.disposables.trackListener(
            spaceStore.getNotificationState(space.roomId),
            NotificationStateEvents.Update,
            this.refresh,
        );
        this.disposables.trackListener(SpaceLayoutStore.instance, SpaceLayoutStoreEvent.Changed, this.refresh);
        this.disposables.trackListener(TimedMutes.instance, TimedMutesEvent.Changed, this.refresh);
        this.disposables.trackListener(client, RoomEvent.AccountData, this.onAccountData);
        this.disposables.trackListener(space, RoomEvent.MyMembership, this.refresh);
        this.disposables.track(() => clearTimeout(this.muteEndTimer));
        this.scheduleMuteEnd();
    }

    private static compute({ space, client, spaceStore }: Props): ServerMenuViewSnapshot {
        const userId = client.getSafeUserId();
        const layout = SpaceLayoutStore.instance;
        const mute = getServerMute(space);
        return {
            canMarkAsRead: spaceStore.getNotificationState(space.roomId).level > NotificationLevel.None,
            canInvite: space.getJoinRule() === JoinRule.Public || space.canInvite(userId),
            isMuted: !!mute,
            mutedUntil: mute?.until,
            notificationLevel: getServerNotificationLevel(space),
            hideMutedChannels: layout.isHidingMutedChannels(space),
            canOpenSettings: shouldShowSpaceSettings(space),
            canCreateChannel:
                hasCreateRoomRights(client, space) &&
                space.currentState.maySendStateEvent(EventType.SpaceChild, userId),
            canCreateCategory: layout.canEditLayout(space),
            showDevtools: SettingsStore.getValue("developerMode"),
        };
    }

    private readonly onAccountData = (...args: unknown[]): void => {
        const [event, room] = args as [MatrixEvent, Room];
        if (room?.roomId === this.props.space.roomId && event.getType() === SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE) {
            this.refresh();
        }
    };

    private readonly refresh = (): void => {
        this.snapshot.merge(ServerMenuViewModel.compute(this.props));
        this.scheduleMuteEnd();
    };

    private scheduleMuteEnd(): void {
        clearTimeout(this.muteEndTimer);
        const until = this.snapshot.current.mutedUntil;
        if (until !== undefined) {
            this.muteEndTimer = setTimeout(this.refresh, Math.min(until - Date.now() + 1, 2 ** 31 - 1));
        }
    }

    public markAsRead = (): void => {
        markServerAsRead(this.props.space).catch((error) => logger.warn("Failed to mark a server as read", error));
    };

    public invite = (): void => showSpaceInvite(this.props.space);

    public mute = (duration: number | null): void => {
        muteServer(this.props.space, duration).catch((error) => logger.warn("Failed to mute a server", error));
    };

    public unmute = (): void => {
        unmuteServer(this.props.space).catch((error) => logger.warn("Failed to unmute a server", error));
    };

    public setNotificationLevel = (level: ServerNotificationLevel): void => {
        setServerNotificationLevel(this.props.space, level).catch((error) =>
            logger.warn("Failed to change a server's notifications", error),
        );
    };

    public toggleHideMutedChannels = (): void => {
        const layout = SpaceLayoutStore.instance;
        layout
            .setHidingMutedChannels(this.props.space, !layout.isHidingMutedChannels(this.props.space))
            .catch(reportLayoutError);
    };

    public openSettings = (): void => showSpaceSettings(this.props.space);

    public changeNickname = (): void => {
        const { client, space } = this.props;
        showServerNicknameDialog(client, space, client.getSafeUserId());
    };

    public createChannel = (): void => {
        void showCreateNewRoom(this.props.space);
    };

    public createCategory = (): void => showCreateCategory(this.props.space);

    public leave = (): void => leaveSpace(this.props.space);

    public openDevtools = (): void => {
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: this.props.space.roomId,
            forceTimeline: true,
            metricsTrigger: undefined,
        });
    };
}
