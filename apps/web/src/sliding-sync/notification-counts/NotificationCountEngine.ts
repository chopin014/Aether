/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    EventType,
    KnownMembership,
    type MatrixClient,
    type MatrixEvent,
    MatrixEventEvent,
    type NotificationCount,
    ReceiptType,
    type Room,
    RoomEvent,
    type RoomHistoryObserver,
    type SyncTimelineInfo,
    THREAD_RELATION_TYPE,
} from "matrix-js-sdk/src/matrix";
import { type SlidingSync, SlidingSyncEvent, SlidingSyncState } from "matrix-js-sdk/src/sliding-sync";

import {
    type Contribution,
    type LedgerEventInput,
    RoomCountLedger,
    type RoomCounts,
    type RunPlacement,
    UNTHREADED_RECEIPT,
} from "./RoomCountLedger";

/** An encrypted event that has not been decrypted: what it adds is not known. */
const NOT_YET_KNOWN: Contribution = { notify: false, highlight: false, final: false };

/** How long one pass of work may take before letting the page paint, in milliseconds. */
const SLICE_MS = 4;

/** How many events a room has evaluated in a pass even when the pass is out of time. */
const MIN_EVALUATIONS = 20;

/**
 * Counts each room's notifications on this device, for sliding sync on servers that send no real counts (Synapse
 * sends zero). It hears every event the rooms gain through the SDK's {@link RoomHistoryObserver}, the user's own
 * receipts, decryptions, redactions and push rule changes, keeps a {@link RoomCountLedger} for each room, and sets
 * the results on the rooms, where the rest of the app reads them as usual.
 *
 * Results are published once the evidence for them is in: a sync response's rooms are published after the whole
 * response is applied, receipts included, so a count never shows events as unread that the same response marks
 * read. Other changes, such as a decryption or the user reading a room, are published at the next task. Work is
 * done in short slices so a large account never blocks the page.
 */
export class NotificationCountEngine implements RoomHistoryObserver {
    private readonly ledgers = new Map<string, RoomCountLedger>();
    /** The events each ledger has, so they can be evaluated when their counts are needed. */
    private readonly roomEvents = new Map<string, Map<string, MatrixEvent>>();
    private readonly published = new Map<string, RoomCounts>();
    private readonly dirty = new Set<string>();
    /** Rooms changed by the sync response being applied; published once it all is. */
    private readonly held = new Set<string>();
    /** Rooms the response being applied sent afresh: once it all is, every receipt the user has there is known. */
    private readonly awaitingReceipts = new Set<string>();
    private inResponse = false;
    private flushTimer?: ReturnType<typeof setTimeout>;
    private started = false;

    public constructor(
        private readonly client: MatrixClient,
        private readonly slidingSync: SlidingSync,
    ) {}

    /** Take over the client's notification counts. */
    public start(): void {
        if (this.started) return;
        this.started = true;
        this.client.setLocalNotificationCounts(true);
        this.client.setRoomHistoryObserver(this);
        this.slidingSync.on(SlidingSyncEvent.Lifecycle, this.onLifecycle);
        this.slidingSync.on(SlidingSyncEvent.Applied, this.onApplied);
        this.client.on(RoomEvent.Receipt, this.onReceipt);
        this.client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
        this.client.on(RoomEvent.Redaction, this.onRedaction);
        this.client.on(RoomEvent.RedactionCancelled, this.onRedactionCancelled);
        this.client.on(ClientEvent.AccountData, this.onAccountData);
        this.client.on(RoomEvent.MyMembership, this.onMyMembership);
    }

    /** Stop counting; the counts set so far stay on the rooms. */
    public stop(): void {
        if (!this.started) return;
        this.started = false;
        if (this.client.getRoomHistoryObserver() === this) this.client.setRoomHistoryObserver(undefined);
        this.slidingSync.off(SlidingSyncEvent.Lifecycle, this.onLifecycle);
        this.slidingSync.off(SlidingSyncEvent.Applied, this.onApplied);
        this.client.off(RoomEvent.Receipt, this.onReceipt);
        this.client.off(MatrixEventEvent.Decrypted, this.onDecrypted);
        this.client.off(RoomEvent.Redaction, this.onRedaction);
        this.client.off(RoomEvent.RedactionCancelled, this.onRedactionCancelled);
        this.client.off(ClientEvent.AccountData, this.onAccountData);
        this.client.off(RoomEvent.MyMembership, this.onMyMembership);
        if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
    }

    /** The counts last set on a room, with how far they can be trusted. */
    public getCounts(roomId: string): RoomCounts | undefined {
        return this.published.get(roomId);
    }

    public onSyncTimeline(room: Room, events: MatrixEvent[], info: SyncTimelineInfo): void {
        if (!this.started) return;
        // A timeline that is neither a fresh start nor cut short follows on from the newest event known.
        const placement: RunPlacement = {
            kind: "live",
            continuesTip: !info.limited && !info.initial && !info.expanded && !info.fromSnapshot,
        };
        this.addEvents(room, events, placement);
        if (info.initial && !info.fromSnapshot) this.awaitingReceipts.add(room.roomId);
        this.markDirty(room.roomId, true);
    }

    public onHistoryPage(room: Room, events: MatrixEvent[], link: { before?: string; after?: string }): void {
        if (!this.started || !this.ledgers.has(room.roomId)) return;
        const placement: RunPlacement =
            link.after !== undefined
                ? { kind: "after", anchor: link.after }
                : { kind: "before", anchor: link.before ?? "" };
        if (this.addEvents(room, events, placement)) this.markDirty(room.roomId);
    }

    public onSavedRoomApplied(room: Room): void {
        // Its saved receipts may not have been all there were, so the room waits for the server's.
        if (this.started) this.markDirty(room.roomId);
    }

    private addEvents(room: Room, events: MatrixEvent[], placement: RunPlacement): boolean {
        const ledger = this.ledgerFor(room.roomId);
        const known = this.eventsFor(room.roomId);
        const me = this.client.getUserId();
        const inputs: LedgerEventInput[] = [];
        for (const event of events) {
            const id = event.getId();
            if (!id) continue;
            inputs.push(toInput(event, me));
        }
        if (!ledger.addRun(inputs, placement)) return false;
        for (const event of events) {
            const id = event.getId();
            // An event the room had already keeps the copy the room has.
            if (!id || known.has(id) || !ledger.has(id)) continue;
            known.set(id, event);
            if (event.isRedacted()) ledger.setRedacted(id, true);
        }
        return true;
    }

    private onLifecycle = (state: SlidingSyncState, response: unknown, error?: Error): void => {
        if (state === SlidingSyncState.RequestFinished && !error && response) this.inResponse = true;
    };

    private onApplied = (): void => {
        this.inResponse = false;
        for (const roomId of this.awaitingReceipts) this.ledgers.get(roomId)?.setReceiptsComplete();
        this.awaitingReceipts.clear();
        this.held.clear();
        this.flush();
    };

    private onReceipt = (event: MatrixEvent, room: Room): void => {
        const me = this.client.getUserId();
        if (!me) return;
        let mine = false;
        const ledger = this.ledgerFor(room.roomId);
        const content = event.getContent<Record<string, Record<string, Record<string, unknown>>>>();
        for (const [eventId, byType] of Object.entries(content)) {
            for (const [type, byUser] of Object.entries(byType ?? {})) {
                const kind = type === ReceiptType.Read ? "public" : type === ReceiptType.ReadPrivate ? "private" : null;
                const receipt = byUser?.[me] as { thread_id?: unknown } | undefined;
                if (!kind || !receipt || typeof receipt !== "object") continue;
                const scope = typeof receipt.thread_id === "string" ? receipt.thread_id : UNTHREADED_RECEIPT;
                ledger.setReceipt(scope, kind, eventId);
                mine = true;
            }
        }
        if (mine) this.markDirty(room.roomId, true);
    };

    private onDecrypted = (event: MatrixEvent): void => {
        const roomId = event.getRoomId();
        const id = event.getId();
        if (!roomId || !id || !this.ledgers.get(roomId)?.has(id)) return;
        // Evaluated again with what it now shows.
        this.ledgers.get(roomId)!.setContribution(id, NOT_YET_KNOWN);
        this.markDirty(roomId);
    };

    private onRedaction = (redaction: MatrixEvent, room: Room): void => {
        this.setRedacted(redaction, room, true);
    };

    private onRedactionCancelled = (redaction: MatrixEvent, room: Room): void => {
        this.setRedacted(redaction, room, false);
    };

    private setRedacted(redaction: MatrixEvent, room: Room, redacted: boolean): void {
        const target = redaction.event.redacts ?? redaction.getContent().redacts;
        const ledger = this.ledgers.get(room.roomId);
        if (typeof target !== "string" || !ledger?.has(target)) return;
        ledger.setRedacted(target, redacted);
        // Undone, it is evaluated again.
        if (!redacted) ledger.setContribution(target, NOT_YET_KNOWN);
        this.markDirty(room.roomId);
    }

    private onAccountData = (event: MatrixEvent): void => {
        if (event.getType() !== EventType.PushRules) return;
        // Every event is evaluated again with the new rules, as its counts are next needed.
        for (const [roomId, ledger] of this.ledgers) {
            ledger.forgetContributions();
            this.markDirty(roomId);
        }
    };

    private onMyMembership = (room: Room, membership: string): void => {
        if (membership === KnownMembership.Join) return;
        this.ledgers.delete(room.roomId);
        this.roomEvents.delete(room.roomId);
        this.published.delete(room.roomId);
        this.dirty.delete(room.roomId);
        room.setNotificationCounts({}, new Map());
    };

    private markDirty(roomId: string, fromSync = false): void {
        this.dirty.add(roomId);
        if (fromSync && this.inResponse) this.held.add(roomId);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushTimer !== undefined || !this.started) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flush();
        }, 0);
    }

    /** Publish the rooms whose counts may have changed, a slice at a time. */
    private flush(): void {
        if (!this.started) return;
        const deadline = performance.now() + SLICE_MS;
        for (const roomId of this.dirty) {
            if (this.held.has(roomId)) continue;
            if (performance.now() > deadline) break;
            if (this.publish(roomId, deadline)) this.dirty.delete(roomId);
        }
        for (const roomId of this.dirty) {
            if (!this.held.has(roomId)) {
                this.scheduleFlush();
                return;
            }
        }
    }

    /**
     * Evaluate what a room's counts need, then set them on the room.
     * @returns false when the slice ran out first: the room is published once the rest is evaluated.
     */
    private publish(roomId: string, deadline: number): boolean {
        const room = this.client.getRoom(roomId);
        const ledger = this.ledgers.get(roomId);
        if (!room || !ledger) return true;
        ledger.setJoined(room.getMyMembership() === KnownMembership.Join);
        // Only events that could count are evaluated, and only once the push rules are there.
        if (this.client.pushRules) {
            const events = this.eventsFor(roomId);
            const pending = ledger.unevaluated();
            for (let i = 0; i < pending.length; i++) {
                // A few at least, so a room always gets somewhere.
                if (i >= MIN_EVALUATIONS && performance.now() > deadline) return false;
                const event = events.get(pending[i]);
                if (event) this.evaluate(ledger, event);
            }
        }
        const counts = ledger.compute();
        this.published.set(roomId, counts);
        const threads = new Map<string, NotificationCount>();
        for (const [threadId, thread] of counts.threads) {
            threads.set(threadId, { total: thread.total, highlight: thread.highlight });
        }
        room.setNotificationCounts({ total: counts.main.total, highlight: counts.main.highlight }, threads);
        this.pruneEvents(roomId, ledger);
        return true;
    }

    private evaluate(ledger: RoomCountLedger, event: MatrixEvent): void {
        const id = event.getId()!;
        if (event.isRedacted()) {
            ledger.setRedacted(id, true);
            return;
        }
        if (event.isEncrypted() && (!event.getClearContent() || event.isDecryptionFailure())) {
            ledger.setContribution(id, NOT_YET_KNOWN);
            // Its decryption is announced, and it is evaluated again then.
            if (event.shouldAttemptDecryption()) void this.client.decryptEventIfNeeded(event);
            return;
        }
        const actions = this.client.pushProcessor.actionsForEvent(event);
        ledger.setContribution(id, { notify: !!actions.notify, highlight: !!actions.tweaks?.highlight, final: true });
    }

    /** Let go of events the ledger no longer has. */
    private pruneEvents(roomId: string, ledger: RoomCountLedger): void {
        const events = this.roomEvents.get(roomId);
        if (!events || events.size <= ledger.size + 200) return;
        for (const id of events.keys()) {
            if (!ledger.has(id)) events.delete(id);
        }
    }

    private ledgerFor(roomId: string): RoomCountLedger {
        let ledger = this.ledgers.get(roomId);
        if (!ledger) {
            ledger = new RoomCountLedger();
            this.ledgers.set(roomId, ledger);
        }
        return ledger;
    }

    private eventsFor(roomId: string): Map<string, MatrixEvent> {
        let events = this.roomEvents.get(roomId);
        if (!events) {
            events = new Map();
            this.roomEvents.set(roomId, events);
        }
        return events;
    }
}

/** What the ledger keeps of an event. Relations are read from the unencrypted part, so they work before decryption. */
function toInput(event: MatrixEvent, me: string | null): LedgerEventInput {
    const relation = event.getWireContent()["m.relates_to"] as { rel_type?: unknown; event_id?: unknown } | undefined;
    const target = typeof relation?.event_id === "string" ? relation.event_id : undefined;
    const inThread = relation?.rel_type === THREAD_RELATION_TYPE.name;
    const own = !!me && event.getSender() === me;
    const joins =
        own &&
        event.getType() === EventType.RoomMember &&
        event.getStateKey() === me &&
        event.getContent().membership === KnownMembership.Join &&
        event.getPrevContent().membership !== KnownMembership.Join;
    return {
        id: event.getId()!,
        own,
        threadRoot: inThread ? target : undefined,
        relatesTo: inThread ? undefined : target,
        joins: joins || undefined,
    };
}
