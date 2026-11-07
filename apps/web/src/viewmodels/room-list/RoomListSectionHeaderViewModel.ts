/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type MatrixEvent, type Room, RoomEvent, RoomType } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { CallType } from "matrix-js-sdk/src/webrtc/call";
import {
    type AcceptedRoomKind,
    BaseViewModel,
    type NotificationDecorationData,
    type RoomListSectionHeaderActions,
    type RoomListSectionHeaderViewSnapshot,
} from "@element-hq/web-shared-components";

import {
    categoryIdOfTag,
    DESKTOP_TEXT_CHANNELS,
    DESKTOP_UNCATEGORIZED,
    DESKTOP_VOICE_CHANNELS,
    isDesktopChannelList,
    isDesktopChannelSection,
} from "./DesktopChannelSections";
import { confirmDeleteCategory, showRenameCategory } from "./serverCategories";
import { TimedMutes, TimedMutesEvent } from "../../stores/notifications/TimedMutes";
import {
    getCategoryMute,
    muteCategory,
    SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE,
    unmuteCategory,
} from "../../stores/notifications/ServerNotifications";
import { clearRoomNotification } from "../../utils/notifications";
import dispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { hasCreateRoomRights } from "./utils";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { showCreateNewRoom } from "../../utils/space";

import { RoomNotificationStateStore } from "../../stores/notifications/RoomNotificationStateStore";
import { NotificationStateEvents } from "../../stores/notifications/NotificationState";
import { type RoomNotificationState } from "../../stores/notifications/RoomNotificationState";
import SettingsStore from "../../settings/SettingsStore";
import RoomListStoreV3 from "../../stores/room-list-v3/RoomListStoreV3";
import { DefaultTagID } from "../../stores/room-list-v3/skip-list/tag";
import {
    CHATS_TAG,
    getCustomSectionData,
    isCustomSectionTag,
    isDefaultSectionTag,
    isReorderableSection,
    isSectionExpanded,
    setSectionExpanded,
} from "../../stores/room-list-v3/section";
import PosthogTrackers from "../../PosthogTrackers";
import { CallStore, CallStoreEvent } from "../../stores/CallStore";
import { type Call, CallEvent } from "../../models/Call";
import throttle from "lodash/throttle";
import { keepIfSame } from "../../utils/keepIfSame";

/**
 * The kind of room the section with the given tag accepts. A room is in the People section because
 * it is a direct message, not because it carries a tag, so a room can never be moved in or out of
 * it; while People is shown, the Chats section holds everything that is not a direct message, for
 * the same reason.
 */
function getAcceptedRoomKind(tag: string): AcceptedRoomKind {
    // Membership decides what is in the Invites section, so rooms can't be moved into it
    if (tag === DefaultTagID.Invite || isDesktopChannelSection(tag)) return "none";
    if (tag === DefaultTagID.DM) return "dm";
    if (tag === CHATS_TAG) {
        // Chats holds the direct messages too when the People section is not shown. The setting is
        // forced off when the sections are turned off, and that case has no drag and drop anyway.
        return SettingsStore.getValue("RoomList.showPeopleSection") ? "nonDm" : "any";
    }
    return "any";
}

/**
 * The kind of channel preselected when creating a channel from a desktop section's header, or undefined when the
 * section cannot create one. The Text and Voice categories create their own kind. A section the user files rooms
 * into, such as a custom section or Favourites, preselects the kind most of its rooms have, so a section of voice
 * channels offers another voice channel.
 */
function getCreateChannelKind(tag: string, spaceId: string, rooms: Room[]): "text" | "voice" | undefined {
    let kind: "text" | "voice" | undefined;
    if (tag === DESKTOP_TEXT_CHANNELS) kind = "text";
    else if (tag === DESKTOP_VOICE_CHANNELS) kind = "voice";
    else if (
        isCustomSectionTag(tag) ||
        tag === DefaultTagID.Favourite ||
        tag === DefaultTagID.LowPriority ||
        categoryIdOfTag(tag) !== undefined
    ) {
        if (!isDesktopChannelList(spaceId)) return undefined;
        const voice = rooms.filter((room) => room.isCallRoom() || room.isElementVideoRoom()).length;
        kind = voice > rooms.length - voice ? "voice" : "text";
    }
    if (!kind) return undefined;
    const client = MatrixClientPeg.get();
    const space = client?.getRoom(spaceId);
    return client && space && hasCreateRoomRights(client, space) ? kind : undefined;
}

interface RoomListSectionHeaderViewModelProps {
    tag: string;
    title: string;
    /**
     * The ID of the current space.
     */
    spaceId: string;
    onToggleExpanded: (isExpanded: boolean) => void;
}

export class RoomListSectionHeaderViewModel
    extends BaseViewModel<RoomListSectionHeaderViewSnapshot, RoomListSectionHeaderViewModelProps>
    implements RoomListSectionHeaderActions
{
    /**
     * The notification states of the rooms currently in this section, used to compute the unread state.
     */
    private roomNotificationStates = new Set<RoomNotificationState>();

    /**
     * The calls of the rooms currently in this section that we are listening to, used to aggregate the call decoration.
     */
    private currentCalls = new Set<Call>();

    /**
     * The rooms currently in this section, which decide the kind of channel its header creates.
     */
    private rooms: Room[] = [];

    public constructor(props: RoomListSectionHeaderViewModelProps) {
        const isDefaultSection = isDefaultSectionTag(props.tag) || isDesktopChannelSection(props.tag);
        super(props, {
            id: props.tag,
            title: props.title,
            // The channels outside any category have no header to open them again, so they never collapse.
            isExpanded: props.tag === DESKTOP_UNCATEGORIZED || isSectionExpanded(props.spaceId, props.tag),
            isUnread: false,
            displaySectionMenu: !isDefaultSection,
            canBeReordered: isReorderableSection(props.tag, getCustomSectionData()),
            acceptedRoomKind: getAcceptedRoomKind(props.tag),
            createChannelKind: getCreateChannelKind(props.tag, props.spaceId, []),
            isHidden: props.tag === DESKTOP_UNCATEGORIZED,
        });
        const sectionWatherRef = SettingsStore.watchSetting("RoomList.CustomSectionData", null, () =>
            this.onCustomSectionDataChange(),
        );
        this.disposables.track(() => SettingsStore.unwatchSetting(sectionWatherRef));

        // Recompute the decoration when a call starts or ends in any room
        this.disposables.trackListener(CallStore.instance, CallStoreEvent.Call, this.onCallChanged);

        // A server category is dimmed while all its channels are muted, and its menu says when the mute ends.
        if (isDesktopChannelSection(props.tag)) {
            this.disposables.trackListener(TimedMutes.instance, TimedMutesEvent.Changed, () => this.updateMuteState());
            const client = MatrixClientPeg.get();
            if (client) this.disposables.trackListener(client, RoomEvent.AccountData, this.onAccountData);
        }
    }

    public onClick = async (): Promise<void> => {
        const isExpanded = !this.snapshot.current.isExpanded;
        // We don't wait to persist the expanded state to storage, as it is not critical and we want the UI to update immediately
        void setSectionExpanded(this.props.spaceId, this.props.tag, isExpanded);
        this.snapshot.merge({ isExpanded });
        this.props.onToggleExpanded(isExpanded);
    };

    /**
     * Whether the section is currently expanded or not.
     */
    public get isExpanded(): boolean {
        return this.snapshot.current.isExpanded;
    }

    /**
     * Set whether the section is expanded for the current space.
     * This will not trigger the onToggleExpanded callback.
     */
    public set isExpanded(value: boolean) {
        if (this.props.tag === DESKTOP_UNCATEGORIZED) return;
        // We don't wait to persist the expanded state to storage, as it is not critical and we want the UI to update immediately
        void setSectionExpanded(this.props.spaceId, this.props.tag, value);
        this.snapshot.merge({ isExpanded: value });

        const kind = value ? "Expand" : "Collapse";
        PosthogTrackers.trackCollapseOrExpandSection(kind, "SectionHeader");
    }

    /**
     * Switch to a different space, restoring the expanded state for that space.
     * Defaults to expanded if no state has been saved for the space.
     */
    public setSpace(spaceId: string): void {
        this.props.spaceId = spaceId;
        const isExpanded =
            this.props.tag === DESKTOP_UNCATEGORIZED || isSectionExpanded(this.props.spaceId, this.props.tag);
        this.snapshot.merge({
            isExpanded,
            createChannelKind: getCreateChannelKind(this.props.tag, spaceId, this.rooms),
        });
    }

    public createChannel = (): void => {
        const space = MatrixClientPeg.get()?.getRoom(this.props.spaceId);
        if (!space) return;
        const type = this.snapshot.current.createChannelKind === "voice" ? RoomType.UnstableCall : undefined;
        // A server category places the new channel in the server's layout; any other section lists the rooms
        // tagged with it, so the new channel is tagged to appear where it was created.
        const categoryId = categoryIdOfTag(this.props.tag);
        const sectionTag = isDesktopChannelSection(this.props.tag) ? undefined : this.props.tag;
        void showCreateNewRoom(space, type, { sectionTag, categoryId, sectionName: this.snapshot.current.title });
    };

    /** Every channel of the category, including the ones the list hides or pins as favourites. */
    private members: Room[] = [];

    /**
     * Show what a server category is called, what the person may do with it, and which channels it holds. Its name
     * can change at any time, and so can the person's right to edit the server's layout.
     */
    public setCategory(category: { title: string; canEdit: boolean; members: Room[] }): void {
        this.members = category.members;
        this.snapshot.merge({
            title: category.title,
            canBeReordered: category.canEdit,
            acceptedRoomKind: category.canEdit ? "nonDm" : "none",
        });
        this.updateMuteState(category.canEdit);
    }

    private get space(): Room | null {
        return MatrixClientPeg.get()?.getRoom(this.props.spaceId) ?? null;
    }

    public muteCategory = (duration: number | null): void => {
        const space = this.space;
        const categoryId = categoryIdOfTag(this.props.tag);
        if (!space || !categoryId) return;
        muteCategory(space, categoryId, this.members, duration).catch((error) =>
            logger.warn("Failed to mute a category", error),
        );
    };

    public unmuteCategory = (): void => {
        const space = this.space;
        const categoryId = categoryIdOfTag(this.props.tag);
        if (!space || !categoryId) return;
        unmuteCategory(space, categoryId, this.members).catch((error) =>
            logger.warn("Failed to unmute a category", error),
        );
    };

    /**
     * Dim the category while every one of its channels is muted, however that happened, and offer to turn its own mute
     * off only when the person muted the category itself.
     */
    private readonly updateMuteState = (canEdit = this.snapshot.current.categoryMenu?.canEdit ?? false): void => {
        if (!isDesktopChannelSection(this.props.tag)) return;
        const mutes = TimedMutes.instance;
        const isMuted = this.members.length > 0 && this.members.every((room) => mutes.isMuted(room));
        const space = this.space;
        const categoryId = categoryIdOfTag(this.props.tag);
        if (!categoryId) {
            this.snapshot.merge({ isMuted });
            return;
        }
        const own = space ? getCategoryMute(space, categoryId, this.members) : undefined;
        this.snapshot.merge({
            isMuted,
            categoryMenu: keepIfSame(this.snapshot.current.categoryMenu, {
                canEdit,
                isMuted: !!own,
                ...(own?.until !== undefined ? { mutedUntil: own.until } : {}),
            }),
        });
    };

    private readonly onAccountData = (...args: unknown[]): void => {
        if ((args[0] as MatrixEvent).getType() === SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE) this.updateMuteState();
    };

    public markCategoryAsRead = (): void => {
        const client = MatrixClientPeg.get();
        if (!client) return;
        for (const room of this.members.length ? this.members : this.rooms) void clearRoomNotification(room, client);
    };

    public collapseAllCategories = (): void => {
        dispatcher.dispatch({ action: Action.RoomListCollapseAllSections });
    };

    public editCategory = (): void => {
        const space = MatrixClientPeg.get()?.getRoom(this.props.spaceId);
        const categoryId = categoryIdOfTag(this.props.tag);
        if (space && categoryId) showRenameCategory(space, categoryId, this.snapshot.current.title);
    };

    public deleteCategory = (): void => {
        const space = MatrixClientPeg.get()?.getRoom(this.props.spaceId);
        const categoryId = categoryIdOfTag(this.props.tag);
        if (space && categoryId) void confirmDeleteCategory(space, categoryId, this.snapshot.current.title);
    };

    /**
     * Update the rooms tracked by this section header for unread state computation.
     * Only subscribes to new rooms and unsubscribes from rooms no longer in the section.
     * @param rooms - The rooms currently in this section
     */
    public setRooms(rooms: Room[]): void {
        // The Invites section only exists while invitations are pending. Collapse it once they have
        // all been handled, so that it is closed again the next time an invitation makes it appear.
        if (this.props.tag === DefaultTagID.Invite && rooms.length === 0) {
            this.snapshot.merge({ isExpanded: false });
        }

        const newStates = new Set(rooms.map((room) => RoomNotificationStateStore.instance.getRoomState(room)));

        // Unsubscribe from rooms no longer in the section
        for (const state of this.roomNotificationStates) {
            if (!newStates.has(state)) {
                state.off(NotificationStateEvents.Update, this.updateNotificationState);
            }
        }

        // Subscribe to newly added rooms
        for (const state of newStates) {
            if (!this.roomNotificationStates.has(state)) {
                // We don't use trackListener because we don't want to grow the disposables indefinitely as rooms are added and removed from the section
                state.on(NotificationStateEvents.Update, this.updateNotificationState);
            }
        }

        this.roomNotificationStates = newStates;
        this.rooms = rooms;
        this.snapshot.merge({ createChannelKind: getCreateChannelKind(this.props.tag, this.props.spaceId, rooms) });
        this.updateCallListeners();
        this.updateNotificationState();
    }

    /**
     * Subscribe to participant/type changes of the calls in the section's rooms, and unsubscribe
     * from calls that are no longer present. Mirrors the call tracking done per room list item.
     */
    private updateCallListeners(): void {
        const newCalls = new Set<Call>();
        for (const state of this.roomNotificationStates) {
            const call = state.room && CallStore.instance.getCall(state.room.roomId);
            if (call) newCalls.add(call);
        }

        // Unsubscribe from calls no longer present
        for (const call of this.currentCalls) {
            if (!newCalls.has(call)) {
                call.off(CallEvent.Participants, this.updateNotificationState);
                call.off(CallEvent.CallTypeChanged, this.updateNotificationState);
            }
        }

        // Subscribe to newly added calls
        for (const call of newCalls) {
            if (!this.currentCalls.has(call)) {
                call.on(CallEvent.Participants, this.updateNotificationState);
                call.on(CallEvent.CallTypeChanged, this.updateNotificationState);
            }
        }

        this.currentCalls = newCalls;
    }

    private onCallChanged = (): void => {
        this.updateCallListeners();
        this.updateNotificationState();
    };

    /**
     * Update the section header from the notification states of the tracked rooms.
     * Computes both the unread (bold) state and a merged notification decoration that aggregates
     * the rooms' notifications. The activity "dot" is intentionally excluded from the decoration.
     */
    private updateNotificationState = throttle(
        (): void => {
            this.doUpdateNotificationState();
        },
        200,
        // Throttled because it iterates every room in the section and fires once per tracked room
        // notification update, which during sync catch-up means once per incoming timeline event
        { leading: true, trailing: true },
    );

    private doUpdateNotificationState = (): void => {
        let isUnread = false;
        let isMention = false;
        let isNotification = false;
        let isUnsentMessage = false;
        let hasUnreadCount = false;
        let invited = false;
        let count = 0;
        let callType: "video" | "voice" | undefined = undefined;

        for (const state of this.roomNotificationStates) {
            if (state.hasAnyNotificationOrActivity) isUnread = true;
            if (state.isMention) isMention = true;
            if (state.isNotification) isNotification = true;
            if (state.isUnsentMessage) isUnsentMessage = true;
            if (state.hasUnreadCount) hasUnreadCount = true;
            if (state.invited) invited = true;
            // Mention, notification, Mark as unread are aggregated
            if (state.isMention || state.isNotification) count += state.count || 1;
            // An invitation reports neither a mention nor a notification, so count it as one room to
            // make a collapsed section show how many invitations it holds
            else if (state.invited) count += 1;

            // Aggregate active calls, preferring a video call over a voice call
            const call = state.room && CallStore.instance.getCall(state.room.roomId);
            if (call && call.participants.size > 0) {
                if (call.callType === CallType.Video) callType = "video";
                else if (call.callType === CallType.Voice && callType !== "video") callType = "voice";
            }
        }

        const notification: NotificationDecorationData = {
            // Drives the decoration's early-return: an activity-only section stays bold but shows no badge
            hasAnyNotificationOrActivity:
                isMention || isNotification || isUnsentMessage || invited || Boolean(callType),
            isUnsentMessage,
            isMention,
            // An invitation counts as a notification here so that the decoration renders the count
            // badge, letting a collapsed Invites section report how many invitations it holds
            isNotification: isNotification || invited,
            hasUnreadCount,
            count,
            callType,
            // The activity dot, the muted bell and the invitation icon are intentionally not
            // aggregated onto the section header, which reports the invitations as a count instead
            isActivityNotification: false,
            invited: false,
            muted: false,
        };

        this.snapshot.merge({ isUnread, notification });
    };

    public dispose(): void {
        this.updateNotificationState.cancel();
        for (const state of this.roomNotificationStates) {
            state.off(NotificationStateEvents.Update, this.updateNotificationState);
        }
        this.roomNotificationStates.clear();
        for (const call of this.currentCalls) {
            call.off(CallEvent.Participants, this.updateNotificationState);
            call.off(CallEvent.CallTypeChanged, this.updateNotificationState);
        }
        this.currentCalls.clear();
        super.dispose();
    }

    /**
     * Handle changes to custom section data.
     */
    private onCustomSectionDataChange(): void {
        const sectionData = isCustomSectionTag(this.props.tag) ? getCustomSectionData()[this.props.tag] : undefined;
        if (sectionData) {
            this.snapshot.merge({ title: sectionData.name });
        }
    }

    public editSection = async (): Promise<void> => {
        await RoomListStoreV3.instance.editSection(this.props.tag);
    };

    public removeSection = async (): Promise<void> => {
        // There is one notification state per room in the section
        const isEmpty = this.roomNotificationStates.size === 0;
        await RoomListStoreV3.instance.removeSection(this.props.tag, isEmpty);

        PosthogTrackers.trackInteraction("WebDeleteSection");
    };
}
