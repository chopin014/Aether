/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DeleteChannelViewSnapshot,
    type DeleteChannelViewActions,
} from "@element-hq/web-shared-components";
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
import { logger } from "matrix-js-sdk/src/logger";

import { canDeleteChannel } from "../../utils/room/canDeleteChannel";
import { _t } from "../../languageHandler";
import { CallStore } from "../../stores/CallStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import dispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type AfterLeaveRoomPayload } from "../../dispatcher/payloads/AfterLeaveRoomPayload";
import { type AfterForgetRoomPayload } from "../../dispatcher/payloads/AfterForgetRoomPayload";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";

interface Props {
    room: Room;
    space: Room;
    client: MatrixClient;
    onFinished: () => void;
}

/** Closes a channel with standard Matrix operations, leaving only after all earlier steps succeed. */
export class DeleteChannelViewModel
    extends BaseViewModel<DeleteChannelViewSnapshot, Props>
    implements DeleteChannelViewActions
{
    private readyToLeave = false;
    private unlinking = false;

    public constructor(props: Props) {
        super(props, { name: props.room.name, busy: false, left: false });
    }

    public cancel = (): void => {
        if (!this.getSnapshot().busy) this.props.onFinished();
    };

    private async fetchRoom(roomId: string): Promise<Room> {
        const { client } = this.props;
        const room = new Room(roomId, client, client.getSafeUserId());
        const events = await client.roomState(roomId);
        room.currentState.setStateEvents(events.map((event) => new MatrixEvent({ ...event, room_id: roomId })));
        return room;
    }

    private progress(progress: string): void {
        this.snapshot.merge({ progress });
    }

    private async waitForLeaveSync(): Promise<void> {
        const { client, room } = this.props;
        const hasLeft = (): boolean => {
            const cached = client.getRoom(room.roomId);
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
                this.disposables.trackListener(client, RoomEvent.MyMembership, listener);
                timer = setTimeout(() => reject(new Error("Waiting for leave to sync timed out")), 30_000);
            });
        } finally {
            client.off(RoomEvent.MyMembership, listener);
            clearTimeout(timer);
        }
    }

    public confirm = async (): Promise<void> => {
        if (this.getSnapshot().busy) return;
        this.snapshot.merge({ busy: true, error: undefined });
        const { room, client } = this.props;
        try {
            this.progress(_t("desktop|delete_channel|checking"));
            // A lost response to leave must not make the retry try to kick members after we have left.
            if (this.readyToLeave && !this.getSnapshot().left) {
                const { joined_rooms: joined } = await client.getJoinedRooms();
                if (!joined.includes(room.roomId)) this.snapshot.merge({ left: true });
            }
            if (!this.getSnapshot().left) {
                if (!this.readyToLeave) await this.closeChannel();

                this.progress(_t("desktop|delete_channel|leaving"));
                const call = CallStore.instance.getActiveCall(room.roomId);
                if (call) await call.disconnect();
                SDKContextClass.instance.legacyCallHandler.hangupOrReject(room.roomId);
                await client.leave(room.roomId);
                this.snapshot.merge({ left: true });
            }

            this.progress(_t("desktop|delete_channel|forgetting"));
            // A RoomView left on this room would fetch it again after forget removes it from the SDK store.
            if (SDKContextClass.instance.roomViewStore.getRoomId() === room.roomId) {
                dispatcher.dispatch<ViewRoomPayload>({
                    action: Action.ViewRoom,
                    room_id: this.props.space.roomId,
                    metricsTrigger: undefined,
                });
            }
            // Otherwise a late leave sync can put the forgotten room back into the SDK store.
            await this.waitForLeaveSync();
            await client.forget(room.roomId);
            dispatcher.dispatch<AfterLeaveRoomPayload>({ action: Action.AfterLeaveRoom, room_id: room.roomId });
            dispatcher.dispatch<AfterForgetRoomPayload>({ action: Action.AfterForgetRoom, room });
            this.props.onFinished();
        } catch (error) {
            logger.warn("Channel deletion interrupted", error);
            this.snapshot.merge({
                error: this.getSnapshot().left
                    ? _t("desktop|delete_channel|forget_error")
                    : _t("desktop|delete_channel|error"),
            });
        } finally {
            this.snapshot.merge({ busy: false });
        }
    };

    private async closeChannel(): Promise<void> {
        const { client, room, space } = this.props;
        const userId = client.getSafeUserId();
        let current = await this.fetchRoom(room.roomId);
        const parent = await this.fetchRoom(space.roomId);
        if (!canDeleteChannel(current, parent, userId, !this.unlinking))
            throw new Error("Channel deletion permissions changed");

        this.progress(_t("desktop|delete_channel|closing"));
        const levels =
            current.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent<IPowerLevelsContent>() ?? {};
        const actor = current.getMember(userId)!;
        // Room v12 creators have infinite power, which cannot be encoded as a state-event number.
        const threshold = Number.isFinite(actor.powerLevel) ? actor.powerLevel : Number.MAX_SAFE_INTEGER;
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

        this.progress(_t("desktop|delete_channel|removing"));
        current = await this.fetchRoom(room.roomId);
        // Reload after locking: members may have joined while the first requests were in flight.
        if (!canDeleteChannel(current, parent, userId, !this.unlinking)) throw new Error("Channel membership changed");
        for (const member of current.getMembers()) {
            if (
                member.userId !== userId &&
                [KnownMembership.Join, KnownMembership.Invite, KnownMembership.Knock].some(
                    (membership) => member.membership === membership,
                )
            ) {
                await client.kick(room.roomId, member.userId, _t("desktop|delete_channel|reason"));
            }
        }
        current = await this.fetchRoom(room.roomId);
        if (
            current
                .getMembers()
                .some(
                    (member) =>
                        member.userId !== userId &&
                        [KnownMembership.Join, KnownMembership.Invite, KnownMembership.Knock].some(
                            (membership) => member.membership === membership,
                        ),
                )
        ) {
            throw new Error("Channel still has members or invitations");
        }

        this.progress(_t("desktop|delete_channel|unlinking"));
        // Remove the optional backlink before the directory entry so a failed request remains retryable.
        if (current.currentState.maySendStateEvent(EventType.SpaceParent, userId)) {
            await client.sendStateEvent(room.roomId, EventType.SpaceParent, {}, space.roomId);
        }
        this.unlinking = true;
        await client.sendStateEvent(space.roomId, EventType.SpaceChild, {}, room.roomId);
        this.readyToLeave = true;
    }
}
