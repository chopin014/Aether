/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopContact,
    type DesktopContactsTab,
    type DesktopContactsViewSnapshot,
    type DesktopContactsViewModel as DesktopContactsViewModelInterface,
} from "@element-hq/web-shared-components";
import {
    ClientEvent,
    RoomEvent,
    RoomMemberEvent,
    User,
    UserEvent,
    type MatrixClient,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import DMRoomMap from "../../utils/DMRoomMap";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { type ViewUserPayload } from "../../dispatcher/payloads/ViewUserPayload";
import { mediaFromMxc } from "../../customisations/Media";
import { _t } from "../../languageHandler";

interface Props {
    client: MatrixClient;
}

/** Projects real Matrix direct conversations, incoming invitations and ignored users into the contacts view. */
export class DesktopContactsViewModel
    extends BaseViewModel<DesktopContactsViewSnapshot, Props>
    implements DesktopContactsViewModelInterface
{
    private allContacts: DesktopContact[] = [];

    public constructor(props: Props) {
        super(props, { tab: "online", query: "", contacts: [], onlineContacts: [], pendingCount: 0, busyIds: [] });
        for (const event of [
            ClientEvent.AccountData,
            ClientEvent.Room,
            RoomEvent.MyMembership,
            RoomEvent.Name,
            RoomMemberEvent.Name,
            UserEvent.Presence,
            UserEvent.DisplayName,
            UserEvent.AvatarUrl,
        ]) {
            this.disposables.trackListener(props.client, event, this.refresh);
        }
        this.refresh();
    }

    private contactFor = (userId: string, room?: Room): DesktopContact => {
        const user = this.props.client.getUser(userId);
        const member = room?.getMember(userId);
        const mxc = member?.getMxcAvatarUrl() ?? user?.avatarUrl;
        return {
            userId,
            name: member?.rawDisplayName || user?.displayName || userId,
            avatarUrl: mxc ? (mediaFromMxc(mxc).getThumbnailOfSourceHttp(64, 64, "crop") ?? undefined) : undefined,
            presence:
                user?.presence === "online" ? "online" : user?.presence === "unavailable" ? "unavailable" : "offline",
            roomId: room?.roomId,
        };
    };

    private readonly refresh = (): void => {
        const { client } = this.props;
        const map = new DMRoomMap(client);
        const blocked = new Set(client.getIgnoredUsers());
        const contacts = new Map<string, DesktopContact>();
        const pending: DesktopContact[] = [];
        const rooms = [...client.getRooms()].sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
        for (const room of rooms) {
            const partner = map.getUserIdForRoomId(room.roomId);
            if (room.getMyMembership() === KnownMembership.Invite) {
                const inviter = partner ?? room.getMember(client.getSafeUserId())?.events.member?.getSender();
                if (inviter && !blocked.has(inviter))
                    pending.push({
                        ...this.contactFor(inviter, room),
                        invited: true,
                        name: partner ? this.contactFor(inviter, room).name : room.name,
                    });
            } else if (
                partner &&
                partner !== client.getUserId() &&
                room.getMyMembership() === KnownMembership.Join &&
                !blocked.has(partner) &&
                !contacts.has(partner)
            ) {
                contacts.set(partner, this.contactFor(partner, room));
            }
        }
        this.allContacts = [
            ...contacts.values(),
            ...pending,
            ...[...blocked].map((id) => ({ ...this.contactFor(id), blocked: true })),
        ];
        this.snapshot.merge({
            pendingCount: pending.length,
            onlineContacts: [...contacts.values()].filter((contact) => contact.presence !== "offline"),
        });
        this.filterContacts();
    };

    private readonly filterContacts = (): void => {
        const { tab, query } = this.snapshot.current;
        const lowerQuery = query.trim().toLocaleLowerCase();
        const contacts = this.allContacts
            .filter((contact) => {
                const tabMatches =
                    tab === "blocked"
                        ? contact.blocked
                        : tab === "pending"
                          ? contact.invited
                          : !contact.blocked && !contact.invited && (tab === "all" || contact.presence !== "offline");
                return (
                    tabMatches &&
                    (!lowerQuery || `${contact.name} ${contact.userId}`.toLocaleLowerCase().includes(lowerQuery))
                );
            })
            .sort((a, b) => a.name.localeCompare(b.name));
        this.snapshot.merge({ contacts });
    };

    public setTab = (tab: DesktopContactsTab): void => {
        this.snapshot.merge({ tab, error: undefined });
        this.filterContacts();
    };
    public setQuery = (query: string): void => {
        this.snapshot.merge({ query });
        this.filterContacts();
    };
    public openHome = (): void => {
        defaultDispatcher.fire(Action.ViewHomePage);
    };
    public startChat = (): void => {
        defaultDispatcher.fire(Action.CreateChat);
    };
    public openConversation = (userId: string): void => {
        const contact = this.allContacts.find(
            (contact) => contact.userId === userId && !contact.invited && !contact.blocked,
        );
        if (!contact?.roomId) return;
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: contact.roomId,
            metricsTrigger: undefined,
        });
    };
    public viewProfile = (userId: string): void => {
        const contact = this.allContacts.find((contact) => contact.userId === userId);
        const member = contact?.roomId ? this.props.client.getRoom(contact.roomId)?.getMember(userId) : undefined;
        defaultDispatcher.dispatch<ViewUserPayload>({
            action: Action.ViewUser,
            member: member ?? this.props.client.getUser(userId) ?? User.createUser(userId, this.props.client),
        });
    };

    private perform = async (id: string, action: () => Promise<unknown>): Promise<void> => {
        if (this.snapshot.current.busyIds.includes(id)) return;
        this.snapshot.merge({ busyIds: [...this.snapshot.current.busyIds, id], error: undefined });
        try {
            await action();
            if (!this.isDisposed) this.refresh();
        } catch {
            if (!this.isDisposed) this.snapshot.merge({ error: _t("desktop|contacts|action_failed") });
        } finally {
            if (!this.isDisposed)
                this.snapshot.merge({ busyIds: this.snapshot.current.busyIds.filter((busyId) => busyId !== id) });
        }
    };
    public acceptInvitation = async (roomId: string): Promise<void> => {
        if (!this.allContacts.some((contact) => contact.roomId === roomId && contact.invited)) return;
        await this.perform(roomId, async () => {
            await this.props.client.joinRoom(roomId);
            defaultDispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: roomId,
                metricsTrigger: undefined,
            });
        });
    };
    public declineInvitation = async (roomId: string): Promise<void> => {
        if (!this.allContacts.some((contact) => contact.roomId === roomId && contact.invited)) return;
        await this.perform(roomId, () => this.props.client.leave(roomId));
    };
    public unblock = async (userId: string): Promise<void> => {
        if (!this.props.client.getIgnoredUsers().includes(userId)) return;
        await this.perform(userId, () =>
            this.props.client.setIgnoredUsers(this.props.client.getIgnoredUsers().filter((id) => id !== userId)),
        );
    };
}
