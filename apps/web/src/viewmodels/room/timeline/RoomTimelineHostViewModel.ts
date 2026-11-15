/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BaseViewModel } from "@element-hq/web-shared-components";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import { RoomTimelineViewModel } from "./RoomTimelineViewModel";
import { RoomTimelineRetention } from "./RoomTimelineRetention";

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

interface ParkedTimeline {
    readonly vm: RoomTimelineViewModel;
    readonly request: RoomTimelineRequest;
    readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Owns the timeline the room view draws through the host: one room's timeline view model at a time.
 *
 * Keeps at most five bounded plain-text models between visits. Views still unmount on release: EventTile's own
 * effects do not support safe parking yet. Compatible models return without a reload, under a fresh lease; all
 * other returns use a new model. Releasing an old lease cannot remove a newer timeline.
 *
 * A timeline given up stops at once, in this order: its lease stops being current, whatever drew it under that lease
 * is told so (see {@link subscribeToRevocation}), its view model stops following the room, and only
 * then does the snapshot say it is gone, for React to take its rows away.
 */
export class RoomTimelineHostViewModel extends BaseViewModel<RoomTimelineHostSnapshot, Props> {
    private nextEntryId = 1;
    /** The lease the host draws its timeline under now, until it is given up; see {@link isCurrent}. */
    private currentLease: RoomTimelineLease | null = null;
    /** Those to tell as the current lease is given up. */
    private revocationListeners = new Set<() => void>();
    private readonly parked = new Map<Room, ParkedTimeline>();
    // A slot releases before its successor binds. Keep one overflow candidate until that binding (or next task),
    // so a six-room cycle can reclaim its destination rather than evicting it just before looking it up.
    private retiring: { room: Room; entry: ParkedTimeline } | null = null;
    private currentRequest: RoomTimelineRequest | null = null;

    public constructor(props: Props) {
        super(props, { entry: null });
    }

    /**
     * Make a timeline view model for `request`, in place of the one the host had, and return its lease. Null, making
     * nothing, once the host is disposed or for another client than its own.
     */
    public bind = (request: RoomTimelineRequest): RoomTimelineLease | null => {
        if (this.isDisposed || request.client !== this.props.client) return null;
        const parked = this.takeParked(request.room);
        this.evict(true);
        this.disposeRetiring();
        const lease: RoomTimelineLease = Object.freeze({ entryId: this.nextEntryId++, room: request.room });
        let reused: RoomTimelineViewModel | undefined;
        if (parked) {
            parked.vm.setSendReadReceiptOnLoad(request.sendReadReceiptOnLoad);
            if (
                !request.initialEventId &&
                parked.request.showReadReceipts === request.showReadReceipts &&
                parked.request.enableReadReceiptsAndMarkersOnActivity ===
                    request.enableReadReceiptsAndMarkersOnActivity &&
                parked.vm.resumeCompatible()
            ) {
                reused = parked.vm;
            } else {
                parked.vm.dispose();
            }
        }
        const vm =
            reused ??
            new RoomTimelineViewModel({
                client: request.client,
                room: request.room,
                initialEventId: request.initialEventId,
                showReadReceipts: request.showReadReceipts,
                sendReadReceiptOnLoad: request.sendReadReceiptOnLoad,
                enableReadReceiptsAndMarkersOnActivity: request.enableReadReceiptsAndMarkersOnActivity,
            });
        this.currentLease = lease;
        this.currentRequest = request;
        this.snapshot.set({ entry: { lease, vm } });
        return lease;
    };

    /** Whether `lease` is the one the host draws its timeline under now. */
    public isCurrent = (lease: RoomTimelineLease): boolean => !this.isDisposed && this.currentLease === lease;

    /**
     * Call `listener` as the timeline drawn under `lease` is given up, once its lease has stopped being current and
     * before its view model is disposed of, so that what draws it can stop at once. Returns what stops the telling.
     * A lease that is not current is given up already: nothing is told.
     */
    public subscribeToRevocation = (lease: RoomTimelineLease, listener: () => void): (() => void) => {
        if (!this.isCurrent(lease)) return () => {};
        this.revocationListeners.add(listener);
        return () => this.revocationListeners.delete(listener);
    };

    /** Revoke the current lease and retain only an eligible model; the view must unmount its descendants. */
    public release = (lease: RoomTimelineLease): void => {
        if (this.isCurrent(lease)) this.evict(true);
    };

    /** Drawing failed: discard the model rather than offering the same failed data on another visit. */
    public discard = (lease: RoomTimelineLease): void => {
        if (this.isCurrent(lease)) this.evict(false);
    };

    public override dispose(): void {
        this.evict(false);
        this.disposeRetiring();
        for (const room of this.parked.keys()) this.takeParked(room)?.vm.dispose();
        super.dispose();
    }

    private takeParked(room: Room): ParkedTimeline | undefined {
        if (this.retiring?.room === room) {
            const { entry } = this.retiring;
            this.retiring = null;
            clearTimeout(entry.timer);
            return entry;
        }
        const parked = this.parked.get(room);
        if (parked) {
            clearTimeout(parked.timer);
            this.parked.delete(room);
        }
        return parked;
    }

    private disposeRetiring(): void {
        if (this.retiring) this.takeParked(this.retiring.room)?.vm.dispose();
    }

    private evict(retain: boolean): void {
        const entry = this.snapshot.current.entry;
        if (!entry || !this.currentLease) return;
        const request = this.currentRequest;
        this.currentRequest = null;
        this.currentLease = null;
        const listeners = this.revocationListeners;
        this.revocationListeners = new Set();
        for (const listener of listeners) listener();
        if (retain && request && entry.vm.parkForReuse()) {
            this.takeParked(request.room)?.vm.dispose();
            if (this.parked.size === 5) {
                this.disposeRetiring();
                const room = this.parked.keys().next().value!;
                const oldest = this.takeParked(room)!;
                this.retiring = {
                    room,
                    entry: { ...oldest, timer: setTimeout(() => this.disposeRetiring(), 0) },
                };
            }
            const timer = setTimeout(() => {
                this.takeParked(request.room)?.vm.dispose();
            }, RoomTimelineRetention.maxAgeMs);
            this.parked.set(request.room, { vm: entry.vm, request, timer });
        } else {
            entry.vm.suspendPresentation();
            entry.vm.dispose();
        }
        // Unless a listener has bound another timeline meanwhile.
        if (this.snapshot.current.entry === entry) this.snapshot.set({ entry: null });
    }
}
