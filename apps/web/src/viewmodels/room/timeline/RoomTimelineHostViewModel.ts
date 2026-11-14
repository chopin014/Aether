/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BaseViewModel } from "@element-hq/web-shared-components";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import { RoomTimelineViewModel } from "./RoomTimelineViewModel";

/**
 * The right to draw one room's timeline through the host, which the room view holds while its timeline is shown.
 * Each binding gets a new one, so a lease left over from an earlier binding is told apart from the current one even
 * for the same room.
 */
export interface RoomTimelineLease {
    /** Never the same twice within one host. */
    readonly entryId: number;
    readonly room: Room;
}

/** What the room view asks of the host when it lends it its timeline's place. */
export interface RoomTimelineRequest {
    readonly client: MatrixClient;
    readonly room: Room;
    /** The message to open the room at, if any; see `RoomTimelineViewModelOpts.initialEventId`. */
    readonly initialEventId?: string;
    readonly showReadReceipts: boolean;
    readonly sendReadReceiptOnLoad: boolean;
    readonly enableReadReceiptsAndMarkersOnActivity: boolean;
}

/** The timeline the host draws, if any, with the lease it is drawn under. */
export interface RoomTimelineHostSnapshot {
    readonly entry: { readonly lease: RoomTimelineLease; readonly vm: RoomTimelineViewModel } | null;
}

interface Props {
    /** The only client whose rooms the host draws. */
    client: MatrixClient;
}

/**
 * Owns the timeline the room view draws through the host: one room's timeline view model at a time.
 *
 * Binding a room makes it a new view model, not yet started, and disposes of the one it had: a timeline lives as long
 * as the binding it was made for, so leaving a room and coming back makes another. Releasing a lease that is no longer
 * current does nothing, so a late release cannot remove a newer timeline.
 */
export class RoomTimelineHostViewModel extends BaseViewModel<RoomTimelineHostSnapshot, Props> {
    private nextEntryId = 1;

    public constructor(props: Props) {
        super(props, { entry: null });
    }

    /**
     * Make a timeline view model for `request`, in place of the one the host had, and return its lease. Null, making
     * nothing, once the host is disposed or for another client than its own.
     */
    public bind = (request: RoomTimelineRequest): RoomTimelineLease | null => {
        if (this.isDisposed || request.client !== this.props.client) return null;
        this.evict();
        const lease: RoomTimelineLease = Object.freeze({ entryId: this.nextEntryId++, room: request.room });
        const vm = new RoomTimelineViewModel({
            client: request.client,
            room: request.room,
            initialEventId: request.initialEventId,
            showReadReceipts: request.showReadReceipts,
            sendReadReceiptOnLoad: request.sendReadReceiptOnLoad,
            enableReadReceiptsAndMarkersOnActivity: request.enableReadReceiptsAndMarkersOnActivity,
        });
        this.snapshot.set({ entry: { lease, vm } });
        return lease;
    };

    /** Whether `lease` is the one the host draws its timeline under now. */
    public isCurrent = (lease: RoomTimelineLease): boolean =>
        !this.isDisposed && this.snapshot.current.entry?.lease === lease;

    /** Dispose of the timeline drawn under `lease`, if it is still the current one. */
    public release = (lease: RoomTimelineLease): void => {
        if (this.isCurrent(lease)) this.evict();
    };

    public override dispose(): void {
        this.evict();
        super.dispose();
    }

    // The lease stops being current before its view model is disposed, so nothing that checks it acts on a disposed one.
    private evict(): void {
        const entry = this.snapshot.current.entry;
        if (!entry) return;
        this.snapshot.set({ entry: null });
        entry.vm.dispose();
    }
}
