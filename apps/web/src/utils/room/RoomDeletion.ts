/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { Disposables } from "@element-hq/web-shared-components";
import {
    EventType,
    KnownMembership,
    JoinRule,
    MatrixEvent,
    Room,
    RoomEvent,
    type MatrixClient,
    type IPowerLevelsContent,
} from "matrix-js-sdk/src/matrix";

import { canDeleteRoom } from "./canDeleteRoom";
import { _t } from "../../languageHandler";
import { CallStore } from "../../stores/CallStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import dispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type AfterLeaveRoomPayload } from "../../dispatcher/payloads/AfterLeaveRoomPayload";
import { type AfterForgetRoomPayload } from "../../dispatcher/payloads/AfterForgetRoomPayload";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";

/** Load complete, authoritative state without changing the client's synced room. */
export async function fetchDeletionRoom(client: MatrixClient, roomId: string): Promise<Room> {
    const room = new Room(roomId, client, client.getSafeUserId());
    const events = await client.roomState(roomId);
    room.currentState.setStateEvents(events.map((event) => new MatrixEvent({ ...event, room_id: roomId })));
    room.name =
        room.currentState.getStateEvents(EventType.RoomName, "")?.getContent().name ??
        client.getRoom(roomId)?.name ??
        roomId;
    return room;
}

/** A retryable room closure, split into phases so a server can close all its rooms before leaving any. */
export class RoomDeletion {
    private readonly disposables = new Disposables();
    private unlinking = false;
    private readyToLeave = false;
    public left = false;
    public complete = false;

    /** Whether member removal and unlinking finished, so retry only needs to leave and forget. */
    public get closed(): boolean {
        return this.readyToLeave;
    }

    public constructor(
        private readonly client: MatrixClient,
        public readonly room: Room,
        public readonly parents: Room[],
        private readonly progress: (progress: string) => void,
        private readonly reason: string,
    ) {}

    public dispose(): void {
        this.disposables.dispose();
    }

    /** Check all permissions before mutation; completed phases stay retryable after unlinking. */
    public async preflight(): Promise<void> {
        if (this.readyToLeave || this.left || this.complete) return;
        const current = await fetchDeletionRoom(this.client, this.room.roomId);
        if (!canDeleteRoom(current, this.client.getSafeUserId())) throw new Error("Room deletion permissions changed");
        for (const parent of this.parents) {
            const state = await fetchDeletionRoom(this.client, parent.roomId);
            if (
                state.getMember(this.client.getSafeUserId())?.membership !== KnownMembership.Join ||
                !state.currentState.maySendStateEvent(EventType.SpaceChild, this.client.getSafeUserId()) ||
                (!this.unlinking &&
                    !Array.isArray(
                        state.currentState.getStateEvents(EventType.SpaceChild, this.room.roomId)?.getContent().via,
                    ))
            )
                throw new Error("Server directory permissions changed");
        }
    }

    /** Prevent new joins, invitations, messages and state changes by the other members. */
    public async prepare(): Promise<void> {
        if (this.readyToLeave || this.left || this.complete) return;
        await this.preflight();
        const { client, room } = this;
        const current = await fetchDeletionRoom(client, room.roomId);
        this.progress(_t("desktop|delete_channel|closing"));
        const levels =
            current.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent<IPowerLevelsContent>() ?? {};
        const power = current.getMember(client.getSafeUserId())!.powerLevel;
        // Room v12 creators have infinite power, which cannot be encoded in a state event.
        const threshold = Number.isFinite(power) ? power : Number.MAX_SAFE_INTEGER;
        await client.sendStateEvent(
            room.roomId,
            EventType.RoomPowerLevels,
            {
                ...levels,
                invite: Math.max(levels.invite ?? 0, threshold),
                events_default: Math.max(levels.events_default ?? 0, threshold),
                state_default: Math.max(levels.state_default ?? 50, threshold),
                events: {
                    ...Object.fromEntries(
                        Object.entries(levels.events ?? {}).map(([type, level]) => [type, Math.max(level, threshold)]),
                    ),
                    [EventType.RoomPowerLevels]: threshold,
                    [EventType.RoomJoinRules]: threshold,
                    [EventType.RoomThirdPartyInvite]: Math.max(
                        levels.events?.[EventType.RoomThirdPartyInvite] ?? 0,
                        threshold,
                    ),
                },
            },
            "",
        );
        await client.sendStateEvent(room.roomId, EventType.RoomJoinRules, { join_rule: JoinRule.Invite }, "");
        for (const invitation of current.currentState.getStateEvents(EventType.RoomThirdPartyInvite)) {
            if (Object.keys(invitation.getContent()).length) {
                await client.sendStateEvent(room.roomId, EventType.RoomThirdPartyInvite, {}, invitation.getStateKey());
            }
        }
    }

    /** Remove every joined member, invite and knock, retaining the deleting administrator. */
    public async removeMembers(): Promise<void> {
        if (this.readyToLeave || this.left || this.complete) return;
        await this.preflight();
        this.progress(_t("desktop|delete_channel|removing"));
        const current = await fetchDeletionRoom(this.client, this.room.roomId);
        for (const member of current.getMembers().filter((member) => this.isOtherMember(member))) {
            await this.client.kick(this.room.roomId, member.userId, this.reason);
        }
        const after = await fetchDeletionRoom(this.client, this.room.roomId);
        if (after.getMembers().some((member) => this.isOtherMember(member)))
            throw new Error("Room still has members or invitations");
    }

    private isOtherMember(member: { userId: string; membership?: string }): boolean {
        return (
            member.userId !== this.client.getSafeUserId() &&
            [KnownMembership.Join, KnownMembership.Invite, KnownMembership.Knock].some(
                (membership) => member.membership === membership,
            )
        );
    }

    /** Unlink all affected server relationships before the administrator leaves. */
    public async unlink(): Promise<void> {
        if (this.readyToLeave || this.left || this.complete) return;
        this.progress(_t("desktop|delete_channel|unlinking"));
        const current = await fetchDeletionRoom(this.client, this.room.roomId);
        for (const parent of this.parents) {
            if (current.currentState.maySendStateEvent(EventType.SpaceParent, this.client.getSafeUserId())) {
                await this.client.sendStateEvent(this.room.roomId, EventType.SpaceParent, {}, parent.roomId);
            }
            this.unlinking = true;
            await this.client.sendStateEvent(parent.roomId, EventType.SpaceChild, {}, this.room.roomId);
        }
        this.readyToLeave = true;
    }

    private async waitForLeaveSync(): Promise<void> {
        const hasLeft = (): boolean => {
            const cached = this.client.getRoom(this.room.roomId);
            return !cached || cached.getMyMembership() === KnownMembership.Leave;
        };
        if (hasLeft()) return;
        let listener!: () => void;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                listener = (): void => {
                    if (hasLeft()) resolve();
                };
                this.disposables.trackListener(this.client, RoomEvent.MyMembership, listener);
                timer = setTimeout(() => reject(new Error("Waiting for leave to sync timed out")), 30_000);
            });
        } finally {
            this.client.off(RoomEvent.MyMembership, listener);
            clearTimeout(timer);
        }
    }

    /** Leave last, then wait for sync and forget the room without restoring it locally. */
    public async finish(): Promise<void> {
        if (this.complete) return;
        if (!this.readyToLeave) throw new Error("Room closure has not finished");
        const { client, room } = this;
        if (!this.left) {
            const { joined_rooms: joined } = await client.getJoinedRooms();
            if (!joined.includes(room.roomId)) this.left = true;
        }
        if (!this.left) {
            this.progress(_t("desktop|delete_channel|leaving"));
            const call = CallStore.instance.getActiveCall(room.roomId);
            if (call) await call.disconnect();
            SDKContextClass.instance.legacyCallHandler.hangupOrReject(room.roomId);
            await client.leave(room.roomId);
            this.left = true;
        }
        this.progress(_t("desktop|delete_channel|forgetting"));
        if (SDKContextClass.instance.roomViewStore.getRoomId() === room.roomId) {
            if (this.parents.length && !room.isSpaceRoom()) {
                dispatcher.dispatch<ViewRoomPayload>({
                    action: Action.ViewRoom,
                    room_id: this.parents[0].roomId,
                    metricsTrigger: undefined,
                });
            } else {
                dispatcher.dispatch({ action: Action.ViewHomePage });
            }
        }
        await this.waitForLeaveSync();
        await client.forget(room.roomId);
        dispatcher.dispatch<AfterLeaveRoomPayload>({ action: Action.AfterLeaveRoom, room_id: room.roomId });
        dispatcher.dispatch<AfterForgetRoomPayload>({ action: Action.AfterForgetRoom, room });
        this.complete = true;
    }
}
