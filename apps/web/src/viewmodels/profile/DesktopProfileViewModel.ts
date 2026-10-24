/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopFullProfileViewActions,
    type DesktopFullProfileViewSnapshot,
    type DesktopProfileMutualItem,
    type DesktopProfilePopoutViewActions,
    type DesktopProfilePopoutViewSnapshot,
    type DesktopProfileRole,
    type UserStatus,
} from "@element-hq/web-shared-components";
import {
    ClientEvent,
    EventTimeline,
    EventType,
    MatrixEvent,
    RoomMember,
    RoomMemberEvent,
    User,
    UserEvent,
    type MatrixClient,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { CryptoEvent } from "matrix-js-sdk/src/crypto-api";
import { copyPlainTextToClipboard } from "@element-hq/element-web-shared-utils";
import { logger } from "matrix-js-sdk/src/logger";

import { getKnownPresence } from "../../utils/knownPresence";
import { isPresenceEnabled } from "../../utils/presence";
import { mediaFromMxc } from "../../customisations/Media";
import { getPowerLevelRole } from "../../Roles";
import { fetchUserStatus } from "../../utils/userStatus";
import { formatFullDateNoTime } from "../../DateUtils";
import DMRoomMap from "../../utils/DMRoomMap";
import SettingsStore from "../../settings/SettingsStore";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { verifyUser } from "../../verification";
import { DirectoryMember, startDmOnFirstMessage } from "../../utils/direct-messages";
import { findDMRoom } from "../../utils/dm/findDMRoom";
import { makeUserPermalink } from "../../utils/permalinks/Permalinks";
import { TimelineRenderingType } from "../../contexts/RoomContext";
import { RightPanelPhases } from "../../stores/right-panel/RightPanelStorePhases";
import type RightPanelStore from "../../stores/right-panel/RightPanelStore";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { type ComposerInsertPayload } from "../../dispatcher/payloads/ComposerInsertPayload";
import {
    confirmAndIgnoreUser,
    unignoreUser,
} from "../../components/viewmodels/right_panel/user_info/UserInfoIgnoreButtonViewModel";
import { EDITOR_STATE_STORAGE_PREFIX } from "../../components/views/rooms/SendMessageComposer";

/** One snapshot serves both the popout card and the full profile. */
export type DesktopProfileViewSnapshot = DesktopFullProfileViewSnapshot & DesktopProfilePopoutViewSnapshot;

/** Matrix dependencies and host callbacks for a profile surface. */
export interface DesktopProfileViewModelProps {
    client: MatrixClient;
    member: RoomMember | User;
    /** The room the person was clicked in, for roles and permissions. */
    room?: Room;
    /** The Space whose roles the member list shows, when the room belongs to the active Space. */
    roleSpace?: Room | null;
    rightPanelStore: RightPanelStore;
    /** Whether the room being viewed has a composer that can receive a mention. */
    isRoomViewed: boolean;
    /** Load the extra facts only the full profile shows. */
    full: boolean;
    onClose(this: void): void;
    onOpenFull(this: void): void;
}

/** Projects Element's real profile, presence, role and verification data; every action delegates to existing flows. */
export class DesktopProfileViewModel
    extends BaseViewModel<DesktopProfileViewSnapshot, DesktopProfileViewModelProps>
    implements DesktopProfilePopoutViewActions, DesktopFullProfileViewActions
{
    private status?: UserStatus;
    private verification?: { verified: boolean; deviceCount: number; hasCrossSigningKeys: boolean };

    public constructor(props: DesktopProfileViewModelProps) {
        super(props, DesktopProfileViewModel.project(props, {}));
        const { client } = props;
        for (const event of [
            UserEvent.Presence,
            UserEvent.LastPresenceTs,
            UserEvent.DisplayName,
            UserEvent.AvatarUrl,
            ClientEvent.AccountData,
            ClientEvent.UserProfileUpdate,
            RoomMemberEvent.PowerLevel,
            RoomMemberEvent.Name,
            RoomMemberEvent.Membership,
            CryptoEvent.UserTrustStatusChanged,
            CryptoEvent.DevicesUpdated,
        ]) {
            // Every one of these only means "re-read": the handlers take different arguments.
            this.disposables.trackListener(client, event, this.refresh);
        }
        this.disposables.trackListener(client, ClientEvent.Event, this.onEvent);
        void this.loadVerification();
        void this.loadStatus();
        if (props.full) void this.loadMutualRooms();
    }

    private static identity(props: DesktopProfileViewModelProps): {
        userId: string;
        name: string;
        mxc?: string;
        user: User | null;
        member?: RoomMember;
    } {
        const { client, member, room } = props;
        const userId = member.userId;
        const roomMember = room?.getMember(userId) ?? (member instanceof RoomMember ? member : undefined);
        const user = client.getUser(userId) ?? (member instanceof User ? member : null);
        return {
            userId,
            name: roomMember?.name || user?.displayName || userId,
            mxc: roomMember?.getMxcAvatarUrl() || user?.avatarUrl || undefined,
            user,
            member: roomMember,
        };
    }

    private static roles(
        props: DesktopProfileViewModelProps,
        userId: string,
        member?: RoomMember,
    ): DesktopProfileRole[] {
        const { client, room, roleSpace } = props;
        // A direct conversation has no roles worth showing: its creator simply holds the top level.
        if (!room || new DMRoomMap(client).getUserIdForRoomId(room.roomId)) return [];
        const roles: DesktopProfileRole[] = [];
        if (roleSpace) {
            const spaceMember = roleSpace.getMember(userId);
            const level = spaceMember?.membership === KnownMembership.Join ? spaceMember.powerLevel : 0;
            const role = getPowerLevelRole(level);
            if (role) roles.push({ key: `space-${role.level}`, label: role.label });
        }
        const channelRole = member && getPowerLevelRole(member.powerLevel);
        if (channelRole && !roles.some((role) => role.label === channelRole.label)) {
            roles.push({ key: `room-${channelRole.level}`, label: channelRole.label });
        }
        return roles;
    }

    /** Everything that can be read synchronously; asynchronous facts arrive through `extra`. */
    private static project(
        props: DesktopProfileViewModelProps,
        extra: Partial<DesktopProfileViewSnapshot> & {
            verification?: { verified: boolean; deviceCount: number; hasCrossSigningKeys: boolean };
        },
    ): DesktopProfileViewSnapshot {
        const { client, room } = props;
        const { userId, name, mxc, user, member } = DesktopProfileViewModel.identity(props);
        const isMe = userId === client.getUserId();
        const presence = isPresenceEnabled(client) ? getKnownPresence(user) : undefined;
        const me = room?.getMember(client.getSafeUserId());
        const canModerate =
            !isMe &&
            !!room &&
            !!me &&
            member?.membership === KnownMembership.Join &&
            me.powerLevel > member.powerLevel &&
            ["kick", "ban", "redact"].some((action) =>
                room.currentState.hasSufficientPowerLevelFor(action as "kick" | "ban" | "redact", me.powerLevel),
            );
        const verification = extra.verification;
        const memberSince =
            props.full && room && member?.membership === KnownMembership.Join ? joinedAt(room, userId) : undefined;
        return {
            userId,
            displayName: name,
            avatarUrl: mxc ? (mediaFromMxc(mxc).getThumbnailOfSourceHttp(160, 160, "crop") ?? undefined) : undefined,
            presence:
                presence === "online" || presence === "unavailable" || presence === "offline" ? presence : undefined,
            roles: DesktopProfileViewModel.roles(props, userId, member),
            status: extra.status,
            isMe,
            canMessage: !isMe && !client.isGuest(),
            canVerify:
                !isMe &&
                !client.isGuest() &&
                !!verification &&
                !verification.verified &&
                verification.deviceCount > 0 &&
                verification.hasCrossSigningKeys,
            isVerified: !!verification?.verified,
            canMention:
                props.isRoomViewed &&
                !!room &&
                !room.isSpaceRoom() &&
                !!room.getMember(userId) &&
                member?.membership === KnownMembership.Join,
            isIgnored: client.isUserIgnored(userId),
            canModerate,
            busy: extra.busy ?? false,
            error: extra.error ?? false,
            memberSince,
            verification:
                verification && (verification.verified || verification.deviceCount > 0)
                    ? { verified: verification.verified, deviceCount: verification.deviceCount }
                    : undefined,
            mutualRooms: extra.mutualRooms ?? { state: props.full ? "loading" : "unsupported", items: [] },
            mutualSpaces: props.full && !isMe ? mutualSpaces(client, userId) : [],
        };
    }

    private readonly refresh = (): void => {
        const { busy, error, mutualRooms } = this.snapshot.current;
        this.snapshot.merge(
            DesktopProfileViewModel.project(this.props, {
                status: this.status,
                verification: this.verification,
                busy,
                error,
                mutualRooms,
            }),
        );
    };

    private readonly onEvent = (event: unknown): void => {
        if (
            event instanceof MatrixEvent &&
            event.getType() === "m.presence" &&
            event.getSender() === this.props.member.userId
        )
            this.refresh();
    };

    private loadStatus = async (): Promise<void> => {
        if (!SettingsStore.getValue("feature_user_status")) return;
        try {
            this.status = await fetchUserStatus(this.props.client, this.props.member.userId);
        } catch (error) {
            logger.warn("Could not load profile status", error);
            return;
        }
        if (!this.isDisposed) this.refresh();
    };

    private loadVerification = async (): Promise<void> => {
        const { client, member } = this.props;
        const crypto = client.getCrypto();
        if (!crypto) return;
        try {
            const [trust, devices, hasCrossSigningKeys] = await Promise.all([
                crypto.getUserVerificationStatus(member.userId),
                crypto.getUserDeviceInfo([member.userId], true),
                crypto.userHasCrossSigningKeys(member.userId, true),
            ]);
            this.verification = {
                verified: trust.isVerified(),
                deviceCount: devices.get(member.userId)?.size ?? 0,
                hasCrossSigningKeys,
            };
        } catch (error) {
            logger.warn("Could not load profile verification", error);
            return;
        }
        if (!this.isDisposed) this.refresh();
    };

    private loadMutualRooms = async (): Promise<void> => {
        const { client, member } = this.props;
        if (member.userId === client.getUserId()) return;
        this.snapshot.merge({ mutualRooms: { state: "loading", items: [] } });
        try {
            if (!(await client.doesServerSupportMutualRooms())) {
                if (!this.isDisposed) this.snapshot.merge({ mutualRooms: { state: "unsupported", items: [] } });
                return;
            }
            const ids = await client.getMutualRooms(member.userId);
            const dmMap = new DMRoomMap(client);
            const items = ids
                .map((id) => client.getRoom(id))
                .filter(
                    (room): room is Room =>
                        !!room &&
                        !room.isSpaceRoom() &&
                        room.getMyMembership() === KnownMembership.Join &&
                        !dmMap.getUserIdForRoomId(room.roomId),
                )
                .map((room) => roomItem(room))
                .sort((a, b) => a.name.localeCompare(b.name));
            if (!this.isDisposed) this.snapshot.merge({ mutualRooms: { state: "ready", items } });
        } catch (error) {
            logger.warn("Could not load mutual rooms", error);
            if (!this.isDisposed) this.snapshot.merge({ mutualRooms: { state: "error", items: [] } });
        }
    };

    public retryMutualRooms = (): void => {
        void this.loadMutualRooms();
    };

    /**
     * Opens the existing direct conversation or begins a new one using Element's own DM flow. A typed message is
     * carried into that room's composer as a draft rather than sent here, so sending, encryption and the
     * create-on-first-message behaviour all stay with the real composer.
     */
    public message = async (draft: string): Promise<void> => {
        const { client, member } = this.props;
        const { busy, canMessage } = this.snapshot.current;
        if (busy || !canMessage) return;
        this.snapshot.merge({ busy: true, error: false });
        try {
            const roomMember = member instanceof RoomMember ? member : undefined;
            const target = new DirectoryMember({
                user_id: member.userId,
                display_name: roomMember?.rawDisplayName ?? (member as User).rawDisplayName,
                avatar_url: roomMember?.getMxcAvatarUrl() ?? (member as User).avatarUrl,
            });
            const text = draft.trim();
            const existing = findDMRoom(client, [target]);
            if (text && existing) this.deliverDraft(existing.roomId, text);
            const roomId = await startDmOnFirstMessage(client, [target]);
            if (!roomId) throw new Error("No direct conversation could be opened");
            // A new DM only exists once the first message is sent, so its room ID is known only now.
            if (text && !existing) this.deliverDraft(roomId, text);
            this.props.onClose();
        } catch (error) {
            logger.warn("Could not open the direct conversation", error);
            if (!this.isDisposed) this.snapshot.merge({ busy: false, error: true });
        }
    };

    private deliverDraft(roomId: string, text: string): void {
        if (this.props.room?.roomId === roomId && this.props.isRoomViewed) {
            // The composer is already mounted and will not re-read its stored draft.
            defaultDispatcher.dispatch<ComposerInsertPayload>({
                action: Action.ComposerInsert,
                text,
                timelineRenderingType: TimelineRenderingType.Room,
            });
            return;
        }
        const key = EDITOR_STATE_STORAGE_PREFIX + roomId;
        let saved: { parts: { type: string; text: string }[]; replyEventId?: string } = { parts: [] };
        try {
            const stored = localStorage.getItem(key);
            if (stored) saved = JSON.parse(stored);
        } catch {
            // An unreadable draft is replaced rather than blocking the message.
        }
        const last = saved.parts[saved.parts.length - 1];
        saved.parts.push({ type: "plain", text: last && !/\s$/.test(last.text ?? "") ? ` ${text}` : text });
        localStorage.setItem(key, JSON.stringify(saved));
    }

    public verify = (): void => {
        const { client, member, rightPanelStore } = this.props;
        const user = client.getUser(member.userId) ?? User.createUser(member.userId, client);
        this.props.onClose();
        verifyUser(rightPanelStore, client, user);
    };

    public mention = (): void => {
        defaultDispatcher.dispatch<ComposerInsertPayload>({
            action: Action.ComposerInsert,
            userId: this.props.member.userId,
            timelineRenderingType: TimelineRenderingType.Room,
        });
        this.props.onClose();
    };

    public copyLink = (): void => {
        void copyPlainTextToClipboard(makeUserPermalink(this.props.member.userId));
    };

    public toggleIgnore = (): void => {
        const { client, member } = this.props;
        if (client.isUserIgnored(member.userId)) void unignoreUser(client, member.userId);
        else void confirmAndIgnoreUser(client, member);
    };

    /** Moderation (kick, ban, power level) lives in the room info panel; this hands the member over to it. */
    public moderate = (): void => {
        const { rightPanelStore, room, member } = this.props;
        const roomMember = room?.getMember(member.userId);
        if (!roomMember) return;
        rightPanelStore.setCards([
            { phase: RightPanelPhases.RoomSummary },
            { phase: RightPanelPhases.MemberList },
            { phase: RightPanelPhases.MemberInfo, state: { member: roomMember } },
        ]);
        this.props.onClose();
    };

    public openFullProfile = (): void => this.props.onOpenFull();
    public close = (): void => this.props.onClose();

    public openRoom = (id: string): void => {
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: id,
            metricsTrigger: undefined,
        });
        this.props.onClose();
    };
}

function roomItem(room: Room): DesktopProfileMutualItem {
    const mxc = room.getMxcAvatarUrl();
    return {
        id: room.roomId,
        name: room.name,
        avatarUrl: mxc ? (mediaFromMxc(mxc).getThumbnailOfSourceHttp(64, 64, "crop") ?? undefined) : undefined,
    };
}

/** Joined Spaces that also list this person as joined, using only members already known locally. */
function mutualSpaces(client: MatrixClient, userId: string): DesktopProfileMutualItem[] {
    return client
        .getRooms()
        .filter(
            (room) =>
                room.isSpaceRoom() &&
                room.getMyMembership() === KnownMembership.Join &&
                room.getMember(userId)?.membership === KnownMembership.Join,
        )
        .map((room) => roomItem(room))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * When the person's current stay in the room began, from the join event in the history loaded so far. A profile
 * change keeps the membership as "join", so only events that follow a non-join state count.
 */
function joinedAt(room: Room, userId: string): { text: string; datetime: string } | undefined {
    let timeline = room.getLiveTimeline();
    while (timeline) {
        const events = timeline.getEvents();
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (
                event.getType() === EventType.RoomMember &&
                event.getStateKey() === userId &&
                event.getContent().membership === KnownMembership.Join &&
                event.getPrevContent().membership !== KnownMembership.Join
            ) {
                const date = new Date(event.getTs());
                return { text: formatFullDateNoTime(date), datetime: date.toISOString() };
            }
        }
        const previous = timeline.getNeighbouringTimeline(EventTimeline.BACKWARDS);
        if (!previous) break;
        timeline = previous;
    }
    return undefined;
}
