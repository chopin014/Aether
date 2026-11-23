/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";
import { shouldUseHydraForRoomVersion } from "matrix-js-sdk/src/utils/roomVersion";

/**
 * How long after a room is made before its link from the Space is treated as missing rather than still being sent.
 * Creating a channel sends the link a moment after the room, and the creator's client sends it then.
 */
export const LINK_GRACE_MS = 10 * 60 * 1000;

/**
 * How long anyone else waits before sending a missing link, so the member who said the room is in the Space, whose
 * own creation left the link out, gets the chance first and other members do not all send the same event.
 */
export const OTHERS_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Restores a Space's link to a channel when creating the channel left it out.
 *
 * A channel is made in two steps: the room is created naming the Space as its parent, then the Space gets an
 * `m.space.child` event for it. When the second step fails, members of the channel still see it in the Space, as their
 * client honours the room's parent, but nobody else does: the Space's own list and the server's hierarchy read only
 * the child events. A member who may add the channel to the Space sends the missing child event.
 *
 * It only acts when the Space holds no child event for the room at all. An admin who removes a channel leaves an
 * empty child event behind, which this never overrides. The room's parent must have been set by someone who may add
 * children to the Space, so a room cannot use this to place itself in a Space it was never let into.
 */
export class SpaceChildRepair {
    private readonly sent = new Set<string>();
    private readonly timers = new Map<string, number>();

    public constructor(private readonly client: MatrixClient) {}

    /** Check every joined room, such as once the rooms are known. */
    public checkAll(): void {
        for (const room of this.client.getRooms()) this.check(room);
    }

    /**
     * Check one room's links to the Spaces it names as its canonical parent, and send any that are missing.
     * @param room - The room, typically one that just arrived or whose parent or Space changed.
     */
    public check(room: Room): void {
        if (room.getMyMembership() !== KnownMembership.Join || isReplaced(room)) return;
        const userId = this.client.getSafeUserId();
        for (const parentEvent of room.currentState.getStateEvents(EventType.SpaceParent)) {
            const spaceId = parentEvent.getStateKey();
            const content = parentEvent.getContent();
            if (!spaceId || !content.canonical || !Array.isArray(content.via) || content.via.length === 0) continue;

            const key = `${spaceId}|${room.roomId}`;
            if (this.sent.has(key)) continue;
            const space = this.client.getRoom(spaceId);
            if (!space?.isSpaceRoom() || space.getMyMembership() !== KnownMembership.Join || isReplaced(space))
                continue;
            // Any child event, even an empty one left by a removal, means the Space has decided about this room.
            if (space.currentState.getStateEvents(EventType.SpaceChild, room.roomId)) continue;
            if (!mayAddChildren(space, userId)) continue;
            const claimedBy = parentEvent.getSender();
            if (!claimedBy || !mayAddChildren(space, claimedBy)) continue;

            const madeAt = room.currentState.getStateEvents(EventType.RoomCreate, "")?.getTs() ?? parentEvent.getTs();
            const wait = madeAt + (claimedBy === userId ? LINK_GRACE_MS : OTHERS_GRACE_MS) - Date.now();
            if (wait > 0) {
                this.recheckLater(key, room, wait);
                continue;
            }
            this.send(key, space, room);
        }
    }

    /** Stop pending checks, such as when the client stops. */
    public stop(): void {
        for (const timer of this.timers.values()) window.clearTimeout(timer);
        this.timers.clear();
    }

    private recheckLater(key: string, room: Room, wait: number): void {
        if (this.timers.has(key) || wait > OTHERS_GRACE_MS) return;
        this.timers.set(
            key,
            window.setTimeout(() => {
                this.timers.delete(key);
                this.check(room);
            }, wait),
        );
    }

    private send(key: string, space: Room, room: Room): void {
        // Once per session: a refused send is not retried on every later state change.
        this.sent.add(key);
        logger.info(`SpaceChildRepair: adding missing link from ${space.roomId} to ${room.roomId}`);
        this.client
            .sendStateEvent(
                space.roomId,
                EventType.SpaceChild,
                { via: [this.client.getDomain()!], suggested: false },
                room.roomId,
            )
            .catch((error) =>
                logger.warn(`SpaceChildRepair: could not link ${room.roomId} from ${space.roomId}`, error),
            );
    }
}

/**
 * Whether a user may add children to a Space. This reads the power levels rather than the user's membership, which
 * sliding sync loads only for members shown on screen.
 */
function mayAddChildren(space: Room, userId: string): boolean {
    const state = space.currentState;
    const create = state.getStateEvents(EventType.RoomCreate, "");
    if (create && shouldUseHydraForRoomVersion(space.getVersion())) {
        // From room version 12 the creators outrank everyone and are not listed in the power levels.
        const additional = create.getContent().additional_creators;
        if (create.getSender() === userId || (Array.isArray(additional) && additional.includes(userId))) return true;
    }
    const levels = state.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
    const required = levels.events?.[EventType.SpaceChild] ?? levels.state_default ?? 50;
    const level = levels.users?.[userId] ?? levels.users_default ?? 0;
    return Number(level) >= Number(required);
}

/** Whether a room was upgraded to a newer one, whose links are kept instead. */
function isReplaced(room: Room): boolean {
    return !!room.currentState.getStateEvents(EventType.RoomTombstone, "");
}
