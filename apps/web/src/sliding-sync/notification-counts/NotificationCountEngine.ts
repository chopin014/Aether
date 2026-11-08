/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    ConditionKind,
    EventType,
    type IPushRule,
    type IPushRules,
    KnownMembership,
    type MatrixClient,
    type MatrixEvent,
    MatrixEventEvent,
    type NotificationCount,
    NotificationCountType,
    ReceiptType,
    type Room,
    RoomEvent,
    type RoomHistoryObserver,
    type SyncTimelineInfo,
    THREAD_RELATION_TYPE,
} from "matrix-js-sdk/src/matrix";
import { type SlidingSync, SlidingSyncEvent, SlidingSyncState } from "matrix-js-sdk/src/sliding-sync";

import { CountRecovery, type CountRecoveryLimits } from "./CountRecovery";
import {
    type Contribution,
    CountConfidence,
    type LedgerEventInput,
    RoomCountLedger,
    type RoomCounts,
    type RunPlacement,
    type SavedLedger,
    type ScopeCounts,
    UNTHREADED_RECEIPT,
} from "./RoomCountLedger";
import {
    announceCountsChanged,
    getInexactCounts,
    InexactCount,
    type InexactScopes,
    setInexactCounts,
} from "./publishedCounts";

/** An encrypted event that has not been decrypted: what it adds is not known. */
const NOT_YET_KNOWN: Contribution = { notify: false, highlight: false, final: false };

/** How long one pass of work may take before letting the page paint, in milliseconds. */
const SLICE_MS = 4;

/** How long publishing what is ready may take at once, such as before the page closes, in milliseconds. */
const FINISH_BUDGET_MS = 30;

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
    /** Whether a live sync response has been applied: history is fetched for counts only from then on. */
    private live = false;
    private readonly recovery: CountRecovery;
    /** Ledgers saved on this device by the last session, taken up as their rooms are restored. */
    private saved = new Map<string, SavedLedger>();
    private changeListener?: (roomId: string) => void;
    /**
     * Rooms restored from a saved ledger whose saved receipts the SDK is replaying: the ledger has them already,
     * knowing which were made on this device, so the replay is not taken as the server's.
     */
    private readonly replaying = new Set<string>();
    /** Rooms whose ledger was started from a saved one. */
    private readonly restoredFromSaved = new Set<string>();

    /**
     * @param recoveryLimits - How much history may be fetched to make counts exact: see {@link CountRecovery}.
     */
    public constructor(
        private readonly client: MatrixClient,
        private readonly slidingSync: SlidingSync,
        recoveryLimits?: Partial<CountRecoveryLimits>,
    ) {
        this.recovery = new CountRecovery(
            client,
            {
                recoveryAnchor: (roomId) => this.ledgers.get(roomId)?.recoveryAnchor(),
                addHistory: (room, events, anchor) => {
                    if (this.started && this.addEvents(room, events, { kind: "before", anchor })) {
                        this.markDirty(room.roomId);
                    }
                },
            },
            recoveryLimits,
        );
    }

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

    /**
     * Stop counting; the counts set so far stay on the rooms. What is ready to publish is published first, so it can
     * be saved; a sync response half applied is left unfinished.
     */
    public stop(): void {
        if (!this.started) return;
        this.finishPending();
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
        this.recovery.stop();
        if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
    }

    /**
     * Let history be fetched to make counts exact, once the room list has found every room: before then it would
     * slow that down, and the rooms it is for are not all known.
     */
    public allowRecovery(): void {
        this.recovery.allow();
    }

    /** The counts last set on a room, with how far they can be trusted. */
    public getCounts(roomId: string): RoomCounts | undefined {
        return this.published.get(roomId);
    }

    /**
     * Start rooms from the ledgers the last session saved, so a room restored from this device shows its counts as
     * they were, before the server answers. Call before the saved rooms are restored.
     */
    public useSaved(saved: ReadonlyMap<string, SavedLedger>): void {
        this.saved = new Map(saved);
    }

    /**
     * Publish at once the rooms whose counts are waiting, other than ones a sync response being applied changed:
     * such as before the page closes, so what is done can be saved. It takes no longer than its budget; rooms it
     * does not reach stay waiting, and keep their last saved record.
     */
    public finishPending(budgetMs = FINISH_BUDGET_MS): void {
        if (!this.started) return;
        const deadline = performance.now() + budgetMs;
        for (const roomId of this.dirty) {
            if (this.held.has(roomId)) continue;
            if (performance.now() > deadline) break;
            if (this.publish(roomId, deadline)) this.dirty.delete(roomId);
        }
    }

    /** Hear which rooms' counts were published, so their ledgers can be saved. */
    public setChangeListener(listener: ((roomId: string) => void) | undefined): void {
        this.changeListener = listener;
    }

    /**
     * A room's ledger to save. A ledger is only saved as it was when its counts were published, so a restored room
     * never shows a half-applied change: "pending" while its counts are being worked out, and "unfinished" once
     * stopped before they were, when the room's last saved record should stand.
     */
    public save(roomId: string): SavedLedger | undefined | "pending" | "unfinished" {
        if (this.dirty.has(roomId) || this.held.has(roomId)) return this.started ? "pending" : "unfinished";
        return this.ledgers.get(roomId)?.save();
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
        if (info.fromSnapshot) {
            if (this.restoredFromSaved.has(room.roomId)) this.replaying.add(room.roomId);
            // Published at once, so the room is announced with its saved counts rather than none.
            // The room is not in the client's store yet, so it is published as given.
            this.dirty.delete(room.roomId);
            if (!this.publish(room.roomId, Infinity, room)) this.markDirty(room.roomId);
            return;
        }
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
        this.replaying.delete(room.roomId);
        this.restoredFromSaved.delete(room.roomId);
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
            // Read here rather than from the room, which may no longer have the event it redacts, such as one from
            // before a gap.
            const target = redactedBy(event);
            if (target) ledger.setRedacted(target, true);
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
        this.live = true;
        // Sent afresh, the room came with every receipt the user has there: receipts made here that it did not
        // include were not kept.
        for (const roomId of this.awaitingReceipts) {
            const ledger = this.ledgers.get(roomId);
            ledger?.setReceiptsComplete();
            ledger?.dropLocalReceipts();
        }
        this.awaitingReceipts.clear();
        this.held.clear();
        this.flush();
    };

    private onReceipt = (event: MatrixEvent, room: Room, synthetic?: boolean, implicit?: boolean): void => {
        const me = this.client.getUserId();
        // One the SDK makes up for the sender of an event says only that they read up to their own event, which the
        // ledger counts already for the events it has.
        if (!me || implicit || this.replaying.has(room.roomId)) return;
        let mine = false;
        // Only the user's receipts matter: others', such as those the SDK makes up for each sender, start no ledger.
        let ledger: RoomCountLedger | undefined;
        const content = event.getContent<Record<string, Record<string, Record<string, unknown>>>>();
        for (const [eventId, byType] of Object.entries(content)) {
            for (const [type, byUser] of Object.entries(byType ?? {})) {
                const kind = type === ReceiptType.Read ? "public" : type === ReceiptType.ReadPrivate ? "private" : null;
                const receipt = byUser?.[me] as { thread_id?: unknown } | undefined;
                if (!kind || !receipt || typeof receipt !== "object") continue;
                const scope = typeof receipt.thread_id === "string" ? receipt.thread_id : UNTHREADED_RECEIPT;
                ledger ??= this.ledgerFor(room.roomId);
                ledger.setReceipt(scope, kind, eventId, !synthetic);
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
        this.ledgers.get(roomId)!.forgetContribution(id);
        this.markDirty(roomId);
    };

    private onRedaction = (redaction: MatrixEvent, room: Room): void => {
        this.setRedacted(redaction, room, true);
    };

    private onRedactionCancelled = (redaction: MatrixEvent, room: Room): void => {
        this.setRedacted(redaction, room, false);
    };

    private setRedacted(redaction: MatrixEvent, room: Room, redacted: boolean): void {
        const target = redactedBy(redaction);
        const ledger = this.ledgers.get(room.roomId);
        if (!target || !ledger) return;
        ledger.setRedacted(target, redacted);
        // Undone, it is evaluated again.
        if (!redacted) ledger.forgetContribution(target);
        this.markDirty(room.roomId);
    }

    private onAccountData = (event: MatrixEvent): void => {
        if (event.getType() !== EventType.PushRules) return;
        // Each room checks, as it is next published, whether the rules its events were evaluated with are these.
        // The server sends them again on every new connection, which then changes nothing.
        for (const roomId of this.ledgers.keys()) this.markDirty(roomId);
    };

    private onMyMembership = (room: Room, membership: string): void => {
        if (membership === KnownMembership.Join) return;
        this.ledgers.delete(room.roomId);
        this.roomEvents.delete(room.roomId);
        this.published.delete(room.roomId);
        this.replaying.delete(room.roomId);
        this.restoredFromSaved.delete(room.roomId);
        this.dirty.delete(room.roomId);
        setInexactCounts(room, undefined);
        room.setNotificationCounts({}, new Map());
        this.announce(room);
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
    private publish(roomId: string, deadline: number, given?: Room): boolean {
        const room = given ?? this.client.getRoom(roomId);
        const ledger = this.ledgers.get(roomId);
        if (!room || !ledger) return true;
        ledger.setJoined(room.getMyMembership() === KnownMembership.Join);
        // Only events that could count are evaluated, and only once the push rules are there.
        if (this.client.pushRules) {
            // What was evaluated with other rules, or with another view of the room, such as another name for the
            // user there, may be wrong now: whether in this session or in the one that saved the ledger.
            const evaluatedWith = `${rulesFingerprint(this.client.pushRules)}\u0001${this.pushContext(room)}`;
            if (ledger.evaluatedWith !== evaluatedWith) {
                ledger.forgetContributions();
                ledger.evaluatedWith = evaluatedWith;
            }
            const events = this.eventsFor(roomId);
            // Each pass evaluates what it reaches, so the list only shrinks and every event gets its turn.
            const pending = ledger.unevaluated();
            for (let i = 0; i < pending.length; i++) {
                // A few at least, so a room always gets somewhere.
                if (i >= MIN_EVALUATIONS && performance.now() > deadline) return false;
                const event = events.get(pending[i]);
                if (event) {
                    this.evaluate(ledger, event);
                } else {
                    // Known only from what was saved, it cannot be evaluated again until it arrives again.
                    ledger.setContribution(pending[i], NOT_YET_KNOWN);
                }
            }
        }
        const previous = this.published.get(roomId);
        const counts = ledger.compute();
        this.published.set(roomId, counts);
        const threads = new Map<string, NotificationCount>();
        for (const [threadId, thread] of counts.threads) {
            threads.set(threadId, { total: thread.total, highlight: thread.highlight });
        }
        const before = getInexactCounts(room);
        const after = inexactScopes(counts);
        setInexactCounts(room, after);
        room.setNotificationCounts({ total: counts.main.total, highlight: counts.main.highlight }, threads);
        const mainFlagChanged = before?.main !== after.main;
        const threadFlagsChanged = [...new Set([...(before?.threads.keys() ?? []), ...after.threads.keys()])].filter(
            (threadId) => before?.threads.get(threadId) !== after.threads.get(threadId),
        );
        // The room announces counts that change. One whose numbers stay the same while how far they can be trusted
        // changes is announced the same way, so its badge gains or loses its "+"; a badge shows that only with a
        // count above zero.
        if (hasPositiveCount(counts)) {
            if (mainFlagChanged) {
                room.emit(RoomEvent.UnreadNotifications, {
                    total: counts.main.total,
                    highlight: counts.main.highlight,
                });
            }
            for (const threadId of threadFlagsChanged) {
                room.emit(RoomEvent.UnreadNotifications, threads.get(threadId) ?? { total: 0, highlight: 0 }, threadId);
            }
        }
        if (mainFlagChanged || threadFlagsChanged.length > 0 || !sameNumbers(previous, counts)) this.announce(room);
        this.pruneEvents(roomId, ledger);
        this.changeListener?.(roomId);
        // A gap keeps the main count from being exact: a little history may fill it.
        const anchor =
            this.live && counts.main.confidence !== CountConfidence.Exact ? ledger.recoveryAnchor() : undefined;
        if (anchor) this.recovery.request(room, anchor);
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

    /**
     * What the push rules read about a room besides the event: the user's name there, the room's power levels, and
     * which member count conditions it meets. Evaluations made with another context are made again.
     */
    private pushContext(room: Room): string {
        const me = this.client.getUserId();
        const name = me ? room.currentState.getMember(me)?.name : undefined;
        const powerLevels = room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getId();
        const memberCount = room.getJoinedMemberCount();
        const conditions = memberCountConditions(this.client.pushRules);
        const meets = conditions.map((condition) => (meetsMemberCount(condition, memberCount) ? "1" : "0")).join("");
        return [name ?? "", powerLevels ?? "", meets].join("\u0000");
    }

    /**
     * Tell whoever shows many rooms' counts that a room's changed. The room it was upgraded into is told too, as its
     * count adds this room's highlights. (A room naming its predecessor without the predecessor's tombstone, as
     * the experimental dynamic predecessors allow, is not told: nothing here leads to it.)
     */
    private announce(room: Room): void {
        announceCountsChanged(room);
        const successorId = room.currentState
            .getStateEvents(EventType.RoomTombstone, "")
            ?.getContent<{ replacement_room?: unknown }>().replacement_room;
        const successor = typeof successorId === "string" ? this.client.getRoom(successorId) : null;
        if (!successor) return;
        successor.emit(RoomEvent.UnreadNotifications, {
            total: successor.getRoomUnreadNotificationCount(NotificationCountType.Total),
            highlight: successor.getRoomUnreadNotificationCount(NotificationCountType.Highlight),
        });
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
            // A saved ledger that cannot be read is dropped: the room is counted afresh.
            const restored = RoomCountLedger.restore(this.saved.get(roomId));
            if (restored) this.restoredFromSaved.add(roomId);
            ledger = restored ?? new RoomCountLedger();
            this.saved.delete(roomId);
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

/**
 * How a count is off, if it is not exact. One that counts only what is certainly unread, while more could be, is a
 * lower bound, shown as "N+". One as last seen is approximate, shown as it is: an event it counts could have been
 * redacted since, so it is no minimum.
 */
function inexactness(counts: ScopeCounts): InexactCount | undefined {
    switch (counts.confidence) {
        case CountConfidence.LowerBound:
        case CountConfidence.Unknown:
            return InexactCount.LowerBound;
        case CountConfidence.LastKnown:
            return InexactCount.Approximate;
        default:
            return undefined;
    }
}

/** Which of a room's counts are not exact, and how. */
function inexactScopes(counts: RoomCounts): InexactScopes {
    const threads = new Map<string, InexactCount>();
    for (const [threadId, thread] of counts.threads) {
        const kind = inexactness(thread);
        if (kind) threads.set(threadId, kind);
    }
    return { main: inexactness(counts.main), threads };
}

/** Whether a room's counts are the same numbers as before, which of them are lower bounds aside. */
function sameNumbers(previous: RoomCounts | undefined, counts: RoomCounts): boolean {
    const same = (a: ScopeCounts | undefined, b: ScopeCounts | undefined): boolean =>
        (a?.total ?? 0) === (b?.total ?? 0) && (a?.highlight ?? 0) === (b?.highlight ?? 0);
    if (!previous || !same(previous.main, counts.main)) return false;
    for (const threadId of new Set([...previous.threads.keys(), ...counts.threads.keys()])) {
        if (!same(previous.threads.get(threadId), counts.threads.get(threadId))) return false;
    }
    return true;
}

/** Whether any of a room's counts is above zero. */
function hasPositiveCount(counts: RoomCounts): boolean {
    if (counts.main.total > 0 || counts.main.highlight > 0) return true;
    for (const thread of counts.threads.values()) {
        if (thread.total > 0 || thread.highlight > 0) return true;
    }
    return false;
}

/** The event a redaction redacts, wherever the room version puts it. */
function redactedBy(event: MatrixEvent): string | undefined {
    if (event.getType() !== EventType.RoomRedaction) return undefined;
    const target = event.event.redacts ?? event.getContent().redacts;
    return typeof target === "string" ? target : undefined;
}

const fingerprints = new WeakMap<IPushRules, string>();

/** A short fingerprint of a set of push rules, the same however their keys are ordered. */
function rulesFingerprint(rules: IPushRules): string {
    let fingerprint = fingerprints.get(rules);
    if (fingerprint === undefined) {
        // FNV-1a over the rules with their keys sorted. A tweak without a value means true, and the SDK sets that
        // on the rules themselves as it evaluates them, so both read the same.
        let hash = 0x811c9dc5;
        const text = JSON.stringify(rules, (_key, value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return value;
            const entries = Object.entries(value);
            if ("set_tweak" in value && !("value" in value)) entries.push(["value", true]);
            return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        });
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        fingerprint = (hash >>> 0).toString(36);
        fingerprints.set(rules, fingerprint);
    }
    return fingerprint;
}

const memberCountCache = new WeakMap<IPushRules, string[]>();

/** The `is` values of the enabled room member count conditions in a set of push rules. */
function memberCountConditions(rules: IPushRules | undefined): string[] {
    if (!rules) return [];
    let conditions = memberCountCache.get(rules);
    if (!conditions) {
        conditions = [];
        for (const kind of Object.values(rules.global ?? {})) {
            for (const rule of (kind as IPushRule[] | undefined) ?? []) {
                if (!rule.enabled) continue;
                for (const condition of rule.conditions ?? []) {
                    if (condition.kind === ConditionKind.RoomMemberCount && typeof condition.is === "string") {
                        conditions.push(condition.is);
                    }
                }
            }
        }
        // The same conditions read the same in whatever order the rules list them.
        conditions = [...new Set(conditions)].sort();
        memberCountCache.set(rules, conditions);
    }
    return conditions;
}

/** Whether a member count meets a room member count condition, such as "2" or ">=10". */
function meetsMemberCount(is: string, count: number): boolean {
    const match = /^(==|<=|>=|<|>)?(\d+)$/.exec(is);
    if (!match) return false;
    const value = Number(match[2]);
    switch (match[1]) {
        case "<":
            return count < value;
        case ">":
            return count > value;
        case "<=":
            return count <= value;
        case ">=":
            return count >= value;
        default:
            return count === value;
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
