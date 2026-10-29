/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ClientEvent, EventType, type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { MatrixRTCSessionEvent, type CallMembership, type SessionMembershipData } from "matrix-js-sdk/src/matrixrtc";
import { logger } from "matrix-js-sdk/src/logger";

import type { Call } from "./Call";

const HANDOFF_EVENT = "io.aether.call.handoff";

/** Moves voice to the newly joined Aether device without signing any device out. */
export class DesktopCallHandoff {
    private disposed = false;
    private readonly ownMemberships = new WeakMap<Call, CallMembership>();

    public constructor(
        private readonly client: MatrixClient,
        private readonly getConnectedCalls: () => Iterable<Call>,
        private readonly onMoved: () => void,
    ) {
        client.on(ClientEvent.ToDeviceEvent, this.onToDevice);
    }

    /** Publish a takeover only after this join has a membership identity echoed by the server. */
    public async claim(call: Call): Promise<void> {
        this.ownMemberships.delete(call);
        const room = this.client.getRoom(call.roomId);
        if (!room || this.disposed) return;
        const session = this.client.matrixRTC.getRoomSession(room);
        const getOwn = (): CallMembership | undefined =>
            session.memberships.find(
                (membership) =>
                    membership.userId === this.client.getUserId() && membership.deviceId === this.client.getDeviceId(),
            );
        if (!getOwn()) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let changed: () => void = () => {};
            try {
                await new Promise<void>((resolve) => {
                    changed = () => {
                        if (getOwn()) resolve();
                    };
                    session.on(MatrixRTCSessionEvent.MembershipsChanged, changed);
                    timer = setTimeout(resolve, 3_000);
                    changed();
                });
            } finally {
                clearTimeout(timer);
                session.off(MatrixRTCSessionEvent.MembershipsChanged, changed);
            }
        }
        const own = getOwn();
        if (!own || !call.connected || this.disposed) return;
        this.ownMemberships.set(call, own);
        const userId = this.client.getUserId()!;
        const deviceId = this.client.getDeviceId()!;
        const targets = new Map<string, { room_id: string; member_id: string; created_ts: number }[]>();
        const staleEvents: { roomId: string; event: MatrixEvent }[] = [];
        for (const otherRoom of this.client.getRooms()) {
            const members = this.client.matrixRTC.getRoomSession(otherRoom).memberships;
            for (const member of members) {
                if (member.userId !== userId || member.deviceId === deviceId || !this.isNewer(own, member)) continue;
                const list = targets.get(member.deviceId) ?? [];
                list.push({ room_id: otherRoom.roomId, member_id: member.memberId, created_ts: member.createdTs() });
                targets.set(member.deviceId, list);
                for (const event of otherRoom.currentState.getStateEvents(EventType.GroupCallMemberPrefix)) {
                    const content = event.getContent<Partial<SessionMembershipData>>();
                    if (
                        event.getId() === member.eventId &&
                        event.getSender() === userId &&
                        content.device_id === member.deviceId
                    ) {
                        staleEvents.push({ roomId: otherRoom.roomId, event });
                    }
                }
            }
        }
        if (!targets.size) return;
        await this.client.sendToDevice(
            HANDOFF_EVENT,
            new Map([
                [
                    userId,
                    new Map(
                        [...targets].map(([targetDevice, sessions]) => [
                            targetDevice,
                            {
                                device_id: deviceId,
                                created_ts: own.createdTs(),
                                targets: sessions,
                            },
                        ]),
                    ),
                ],
            ]),
        );
        if (!call.connected || this.disposed) return;
        // Offline devices cannot acknowledge. Remove only the exact older state records we saw;
        // a device that has joined again in the meantime owns a different event and is left alone.
        await Promise.all(
            staleEvents.map(async ({ roomId, event }) => {
                const key = event.getStateKey()!;
                const current = this.client
                    .getRoom(roomId)
                    ?.currentState.getStateEvents(EventType.GroupCallMemberPrefix, key);
                if (current?.getId() === event.getId()) {
                    await this.client.sendStateEvent(roomId, EventType.GroupCallMemberPrefix, {}, key);
                }
            }),
        );
    }

    private isNewer(source: CallMembership, previous: CallMembership): boolean {
        return (
            source.createdTs() > previous.createdTs() ||
            (source.createdTs() === previous.createdTs() && source.deviceId > previous.deviceId)
        );
    }

    private readonly onToDevice = (event: MatrixEvent): void => {
        void this.receive(event).catch((error) => logger.warn("Could not move the call to another device", error));
    };

    private async receive(event: MatrixEvent): Promise<void> {
        if (event.getType() !== HANDOFF_EVENT || event.getSender() !== this.client.getUserId() || this.disposed) return;
        const content = event.getContent<Record<string, unknown>>();
        const { device_id: sourceDevice, created_ts: sourceCreatedTs, targets } = content;
        if (
            typeof sourceDevice !== "string" ||
            sourceDevice === this.client.getDeviceId() ||
            typeof sourceCreatedTs !== "number" ||
            !Number.isFinite(sourceCreatedTs) ||
            !Array.isArray(targets)
        )
            return;
        const toLeave = [...this.getConnectedCalls()].filter((call) => {
            const own = this.ownMemberships.get(call);
            if (!own || !call.connected) return false;
            if (
                sourceCreatedTs < own.createdTs() ||
                (sourceCreatedTs === own.createdTs() && sourceDevice <= own.deviceId)
            )
                return false;
            return targets.some((target: unknown) => {
                if (!target || typeof target !== "object") return false;
                const item = target as Record<string, unknown>;
                return (
                    item.room_id === call.roomId &&
                    item.member_id === own.memberId &&
                    item.created_ts === own.createdTs()
                );
            });
        });
        if (!toLeave.length) return;
        await Promise.all(toLeave.map((call) => call.disconnect()));
        if (!this.disposed) this.onMoved();
    }

    /** Stop accepting handoffs when this client logs out. */
    public dispose(): void {
        this.disposed = true;
        this.client.off(ClientEvent.ToDeviceEvent, this.onToDevice);
    }
}
