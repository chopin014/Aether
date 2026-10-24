/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    type MatrixClient,
    type MatrixEvent,
    ReceiptType,
    type Room,
    RoomEvent,
    type RoomMember,
    RoomMemberEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

export enum ActivityTrackerEvent {
    /** A user's last-active time moved forward. The payload is the user ID. */
    Update = "update",
}

type HandlerMap = { [ActivityTrackerEvent.Update]: (userId: string) => void };

/**
 * Remembers when each user was last seen doing something, using only data the client already has: the messages they
 * sent, their read receipts and typing notifications. It scans the loaded rooms once, then follows live updates, so
 * views can ask about any user without scanning rooms themselves.
 *
 * This says nothing about whether someone is online now, only that they were seen at a given time.
 */
export class ActivityTracker extends TypedEventEmitter<ActivityTrackerEvent, HandlerMap> {
    private readonly lastActive = new Map<string, number>();
    private started = false;

    public constructor(
        private readonly client: MatrixClient,
        private readonly now: () => number = Date.now,
    ) {
        super();
    }

    public start(): void {
        if (this.started) return;
        this.started = true;
        this.client.on(RoomEvent.Timeline, this.onTimeline);
        this.client.on(RoomEvent.Receipt, this.onReceipt);
        this.client.on(RoomMemberEvent.Typing, this.onTyping);
        this.client.on(ClientEvent.Room, this.scanRoom);
        for (const room of this.client.getRooms()) this.scanRoom(room);
    }

    public stop(): void {
        this.started = false;
        this.client.off(RoomEvent.Timeline, this.onTimeline);
        this.client.off(RoomEvent.Receipt, this.onReceipt);
        this.client.off(RoomMemberEvent.Typing, this.onTyping);
        this.client.off(ClientEvent.Room, this.scanRoom);
        this.lastActive.clear();
    }

    /** When we last saw this user do something, in milliseconds since the epoch. */
    public getLastActive(userId: string): number | undefined {
        return this.lastActive.get(userId);
    }

    private record(userId: string | undefined, ts: number | undefined): void {
        if (!userId || ts === undefined || !Number.isFinite(ts)) return;
        // A skewed clock must not make someone look active in the future.
        const at = Math.min(ts, this.now());
        if (at <= (this.lastActive.get(userId) ?? 0)) return;
        this.lastActive.set(userId, at);
        this.emit(ActivityTrackerEvent.Update, userId);
    }

    private scanRoom = (room: Room): void => {
        if (room.getMyMembership() !== KnownMembership.Join) return;
        for (const event of room.getLiveTimeline().getEvents()) this.recordEvent(event);
        for (const member of room.getJoinedMembers()) {
            for (const type of [ReceiptType.Read, ReceiptType.ReadPrivate]) {
                this.record(member.userId, room.getReadReceiptForUserId(member.userId, true, type)?.data.ts);
            }
        }
    };

    private recordEvent(event: MatrixEvent): void {
        // Membership changes and the like are done to someone, not by them; unsent echoes have not happened yet.
        if (event.isState() || event.status) return;
        this.record(event.getSender(), event.getTs());
    }

    private onTimeline = (event: MatrixEvent, room: Room | undefined, toStartOfTimeline: boolean | undefined): void => {
        if (!room || toStartOfTimeline) return;
        this.recordEvent(event);
    };

    private onReceipt = (event: MatrixEvent): void => {
        const content = event.getContent<Record<string, Record<string, Record<string, { ts?: number }>>>>();
        for (const types of Object.values(content)) {
            for (const users of Object.values(types ?? {})) {
                for (const [userId, receipt] of Object.entries(users ?? {})) this.record(userId, receipt?.ts);
            }
        }
    };

    private onTyping = (_event: MatrixEvent, member: RoomMember): void => {
        if (member.typing) this.record(member.userId, this.now());
    };
}
