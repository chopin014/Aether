/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DeleteServerViewSnapshot,
    type DeleteServerViewActions,
} from "@element-hq/web-shared-components";
import { EventType, type Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { RoomDeletion, fetchDeletionRoom } from "../../utils/room/RoomDeletion";
import { _t } from "../../languageHandler";

interface Props {
    client: MatrixClient;
    space: Room;
    onFinished: () => void;
}

/** Deletes every linked room and nested server, checking the entire graph before the first mutation. */
export class DeleteServerViewModel
    extends BaseViewModel<DeleteServerViewSnapshot, Props>
    implements DeleteServerViewActions
{
    private deletions: RoomDeletion[] = [];
    private started = false;
    private currentName: string;

    public constructor(props: Props) {
        super(props, {
            name: props.space.name,
            rooms: [],
            ready: false,
            busy: true,
            confirmation: "",
            progress: _t("desktop|delete_server|checking"),
        });
        this.currentName = props.space.name;
        void this.load();
    }

    public setConfirmation = (confirmation: string): void => {
        if (!this.getSnapshot().busy) this.snapshot.merge({ confirmation });
    };

    public cancel = (): void => {
        if (!this.getSnapshot().busy) this.props.onFinished();
    };

    private async load(): Promise<void> {
        this.snapshot.merge({ busy: true, error: undefined, progress: _t("desktop|delete_server|checking") });
        const workers = new Map<string, RoomDeletion>();
        const order: RoomDeletion[] = [];
        try {
            const visit = async (id: string, parent?: Room): Promise<void> => {
                const existing = workers.get(id);
                if (existing) {
                    if (parent && !existing.parents.some((room) => room.roomId === parent.roomId))
                        existing.parents.push(parent);
                    return;
                }
                this.currentName = this.props.client.getRoom(id)?.name ?? id;
                const room = await fetchDeletionRoom(this.props.client, id);
                this.currentName = room.name;
                const worker = this.disposables.track(
                    new RoomDeletion(
                        this.props.client,
                        room,
                        parent ? [parent] : [],
                        (progress) =>
                            this.snapshot.merge({
                                progress: _t("desktop|delete_server|progress", { name: room.name, progress }),
                            }),
                        _t("desktop|delete_server|reason"),
                    ),
                );
                workers.set(id, worker);
                if (room.isSpaceRoom()) {
                    for (const child of this.children(room)) await visit(child, room);
                }
                order.push(worker);
            };
            await visit(this.props.space.roomId);
            // Keep the root until the end, including when the hierarchy links back to itself.
            this.deletions = [
                ...order.filter((worker) => worker.room.roomId !== this.props.space.roomId),
                workers.get(this.props.space.roomId)!,
            ];
            for (const worker of this.deletions) {
                this.currentName = worker.room.name;
                await worker.preflight();
            }
            this.snapshot.merge({
                ready: true,
                rooms: this.deletions
                    .filter((worker) => worker.room.roomId !== this.props.space.roomId)
                    .map(({ room }) => ({
                        id: room.roomId,
                        name: room.name,
                        kind: room.isSpaceRoom()
                            ? "space"
                            : room.isCallRoom() || room.isElementVideoRoom()
                              ? "voice"
                              : "text",
                    })),
            });
        } catch (error) {
            logger.warn("Unable to prepare server deletion", error);
            this.snapshot.merge({
                ready: false,
                error: _t("desktop|delete_server|blocked", { name: this.currentName }),
            });
        } finally {
            this.snapshot.merge({ busy: false });
        }
    }

    private children(room: Room): string[] {
        return room.currentState
            .getStateEvents(EventType.SpaceChild)
            .filter((event) => Array.isArray(event.getContent().via) && event.getContent().via.length > 0)
            .map((event) => event.getStateKey()!);
    }

    private async verifyHierarchy(): Promise<void> {
        for (const worker of this.deletions) {
            if (!worker.room.isSpaceRoom() || worker.closed || worker.left || worker.complete) continue;
            const expected = new Set(
                this.deletions
                    .filter((child) => child.parents.some((parent) => parent.roomId === worker.room.roomId))
                    .map((child) => child.room.roomId),
            );
            this.currentName = worker.room.name;
            const current = await fetchDeletionRoom(this.props.client, worker.room.roomId);
            if (this.children(current).some((id) => !expected.has(id))) throw new Error("Server hierarchy changed");
        }
    }

    public confirm = async (): Promise<void> => {
        const snapshot = this.getSnapshot();
        if (snapshot.busy) return;
        if (!snapshot.ready) {
            await this.load();
            return;
        }
        if (snapshot.confirmation !== snapshot.name) return;
        this.snapshot.merge({ busy: true, error: undefined });
        try {
            // All permissions are checked again at confirmation, before even locking a room.
            for (const worker of this.deletions) {
                this.currentName = worker.room.name;
                await worker.preflight();
            }
            this.started = true;
            for (const phase of ["prepare", "removeMembers", "unlink", "finish"] as const) {
                if (phase === "removeMembers" || phase === "unlink") await this.verifyHierarchy();
                for (const worker of this.deletions) {
                    this.currentName = worker.room.name;
                    await worker[phase]();
                }
            }
            this.props.onFinished();
        } catch (error) {
            logger.warn("Server deletion interrupted", error);
            this.snapshot.merge({
                error: this.started
                    ? _t("desktop|delete_server|interrupted", { name: this.currentName })
                    : _t("desktop|delete_server|blocked", { name: this.currentName }),
            });
        } finally {
            this.snapshot.merge({ busy: false });
        }
    };
}
