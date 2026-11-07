/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** The scope of a room's main timeline, as opposed to one of its threads (named by the thread's root event). */
export const MAIN_SCOPE = "main";

/** Which receipts apply to every scope of the room: those sent without a thread. */
export const UNTHREADED_RECEIPT = "unthreaded";

/** How far a count can be trusted. */
export enum CountConfidence {
    /** Every event that could count is known, placed and evaluated. */
    Exact = "exact",
    /** At least this many: the events counted are certainly unread, but some others could not be checked. */
    LowerBound = "lowerBound",
    /** Nothing is certainly unread, but some events could not be checked. */
    Unknown = "unknown",
}

/** The notifications of one scope: the main timeline or one thread. */
export interface ScopeCounts {
    /** Unread events whose push actions notify. */
    total: number;
    /** Unread events whose push actions highlight. */
    highlight: number;
    confidence: CountConfidence;
}

/** The notifications of a room, by scope. */
export interface RoomCounts {
    main: ScopeCounts;
    /** By thread root ID; only threads with events this ledger knows. */
    threads: Map<string, ScopeCounts>;
}

/** What the ledger needs to know about an event, read from it once when it arrives. */
export interface LedgerEventInput {
    id: string;
    /** Sent by the user whose notifications these are. Such events never notify and count as read receipts. */
    own: boolean;
    /** The root of the thread this event replies in. */
    threadRoot?: string;
    /** The event this one relates to otherwise, such as the event an edit or reaction is for. */
    relatesTo?: string;
    /** The user's own join to the room (not a change of their name or avatar while joined). */
    joins?: boolean;
}

/** What an event adds to the counts when unread, from the user's push rules. */
export interface Contribution {
    notify: boolean;
    highlight: boolean;
    /**
     * False when the push rules could only see part of the event, such as an encrypted event not yet decrypted. The
     * event is then not counted, and makes its scope inexact.
     */
    final: boolean;
}

/** Where an unbroken stretch of events sits in the room. */
export type RunPlacement =
    /** The newest events of the room, from sync. `continuesTip`: they follow on from the newest event known. */
    | { kind: "live"; continuesTip: boolean }
    /** Events that come just before the given event, such as a page of history. */
    | { kind: "before"; anchor: string }
    /** Events that come just after the given event. */
    | { kind: "after"; anchor: string };

type ReceiptKind = "public" | "private";

interface Segment {
    /** Higher is newer. The newest segment holds the newest events of the room. */
    order: number;
    events: LedgerEvent[];
}

interface LedgerEvent extends LedgerEventInput {
    segment: Segment;
    /** Increases through the segment. */
    position: number;
    contribution?: Contribution;
    redacted: boolean;
}

/** Where a read receipt or similar point sits, if the ledger knows its event. */
interface Frontier {
    /** The newest known point: everything up to it is read. */
    known?: LedgerEvent;
    /** A point whose event the ledger does not know. */
    dangling: boolean;
}

/** How many events a room keeps; older ones are let go, and counts relying on them stop being exact. */
const MAX_EVENTS = 2000;

/**
 * The notification counts of one room, worked out on this device from the events and receipts it has seen.
 *
 * The ledger keeps the events it was given in stretches ("segments") of the room's timeline, each unbroken,
 * ordered from oldest to newest. Between two segments there may be events it was never given. It also keeps the
 * user's read receipts, and what each event adds to the counts when unread.
 *
 * An event is unread in its scope when no read receipt for that scope is at or after it. Receipts sent without a
 * thread cover every scope; the user's own events and their join count as receipts too. A receipt whose event the
 * ledger has not been given sits before the newest segment: the server only sends receipts for events it has, and
 * the newest segment always reaches the newest event. Older segments may come before or after such a receipt, so
 * their events are neither read nor unread until more is known.
 *
 * A count is exact when there is no gap between its scope's newest receipt and the newest event, every receipt is
 * known, and every unread event there has been evaluated. Otherwise it is a lower bound of what is certainly unread.
 */
export class RoomCountLedger {
    private readonly events = new Map<string, LedgerEvent>();
    private segments: Segment[] = [];
    private nextOrder = 0;
    /** By receipt scope ("main", a thread root or {@link UNTHREADED_RECEIPT}), then kind. */
    private readonly receipts = new Map<string, Partial<Record<ReceiptKind, string>>>();
    private receiptsComplete = false;
    private joined = false;

    /** How many events the ledger holds. */
    public get size(): number {
        return this.events.size;
    }

    /** Whether the ledger has been given this event. */
    public has(eventId: string): boolean {
        return this.events.has(eventId);
    }

    /**
     * Add an unbroken stretch of the room's events, oldest first. Events already known keep their place and the
     * stretches they join become one.
     * @returns whether the stretch was kept: one that cannot be placed is dropped.
     */
    public addRun(run: LedgerEventInput[], placement: RunPlacement): boolean {
        const fresh = new Set<string>();
        const inputs = run.filter((event) => {
            if (fresh.has(event.id)) return false;
            fresh.add(event.id);
            return true;
        });
        if (inputs.length === 0) return true;

        // History joins the event it was fetched next to, as if that event were part of it.
        if (placement.kind !== "live" && !fresh.has(placement.anchor)) {
            const anchor = this.events.get(placement.anchor);
            if (anchor) {
                if (placement.kind === "before") {
                    inputs.push(anchor);
                } else {
                    inputs.unshift(anchor);
                }
            }
        }
        const touched = new Set<Segment>();
        for (const input of inputs) {
            const known = this.events.get(input.id);
            if (known) touched.add(known.segment);
        }
        if (touched.size > 0) {
            this.mergeRun(inputs, touched, placement.kind === "live");
        } else if (placement.kind !== "live") {
            return false;
        } else {
            const live = this.liveSegment();
            if (live && placement.continuesTip) {
                this.insertAt(live, live.events.length, inputs);
            } else {
                this.insertAt(this.newSegment(), 0, inputs);
            }
        }
        this.trim();
        return true;
    }

    /** Record what an event adds to the counts when unread. */
    public setContribution(eventId: string, contribution: Contribution): void {
        const event = this.events.get(eventId);
        if (event) event.contribution = contribution;
    }

    /** Forget what every event adds, so each is evaluated again: for when the push rules change. */
    public forgetContributions(): void {
        for (const event of this.events.values()) event.contribution = undefined;
    }

    /** Record that an event was redacted, or that a pending redaction of it was undone. */
    public setRedacted(eventId: string, redacted: boolean): void {
        const event = this.events.get(eventId);
        if (event) event.redacted = redacted;
    }

    /**
     * Record one of the user's read receipts.
     * @param scope - The receipt's thread: "main", a thread root, or {@link UNTHREADED_RECEIPT}.
     * @param kind - Public (`m.read`) or private (`m.read.private`). Both mark events read.
     * @param eventId - The event read up to.
     */
    public setReceipt(scope: string, kind: ReceiptKind, eventId: string): void {
        const byKind = this.receipts.get(scope) ?? {};
        const previousId = byKind[kind];
        const previous = previousId !== undefined ? this.events.get(previousId) : undefined;
        const next = this.events.get(eventId);
        // A receipt never moves back. When both events are known, the later one stays; otherwise the newer receipt
        // wins, as the server ignores receipts that would move one back.
        if (previous && next && compare(next, previous) < 0) return;
        byKind[kind] = eventId;
        this.receipts.set(scope, byKind);
    }

    /** Record that every receipt the user has in this room is known: a scope without one has never been read. */
    public setReceiptsComplete(): void {
        this.receiptsComplete = true;
    }

    /**
     * Record whether the user is joined. Nothing before their latest join can be unread: when the ledger does not
     * have that join, it is before the newest segment.
     */
    public setJoined(joined: boolean): void {
        this.joined = joined;
    }

    /** Events that could count but have no contribution yet, newest first, so they can be evaluated. */
    public unevaluated(): string[] {
        const result: string[] = [];
        const frontiers = this.frontiers();
        this.forEachNewestFirst((event) => {
            if (event.own || event.redacted || event.contribution?.final) return;
            if (this.readState(event, frontiers) !== "read") result.push(event.id);
        });
        return result;
    }

    /** Work out the counts from what the ledger knows now. */
    public compute(): RoomCounts {
        const frontiers = this.frontiers();
        const tallies = new Map<string, { total: number; highlight: number; inexact: boolean }>();
        const tally = (scope: string): { total: number; highlight: number; inexact: boolean } => {
            let entry = tallies.get(scope);
            if (!entry) {
                entry = { total: 0, highlight: 0, inexact: false };
                tallies.set(scope, entry);
            }
            return entry;
        };
        tally(MAIN_SCOPE);

        this.forEachNewestFirst((event) => {
            const routed = this.scopeOf(event);
            // An event whose scope is not known yet, such as a reaction to an event not seen, is kept with the main
            // timeline. If it could count, the main count is not exact.
            const scope = routed ?? MAIN_SCOPE;
            const entry = tally(scope);
            if (event.own || event.redacted) return;
            const state = this.readState(event, frontiers);
            if (state === "read") return;
            const contribution = event.contribution;
            if (!contribution?.final) {
                entry.inexact = true;
                return;
            }
            if (!routed && (contribution.notify || contribution.highlight)) entry.inexact = true;
            if (state === "unresolved") {
                if (contribution.notify || contribution.highlight) entry.inexact = true;
                return;
            }
            if (contribution.notify) entry.total++;
            if (contribution.highlight) entry.highlight++;
        });

        const live = this.liveSegment();
        const result: RoomCounts = { main: emptyCounts(), threads: new Map() };
        for (const [scope, entry] of tallies) {
            const frontier = this.frontierFor(scope, frontiers);
            // Exact needs the newest receipt in the newest segment: then there is no gap after it.
            const covered = this.receiptsComplete && !!frontier.known && frontier.known.segment === live;
            const exact = covered && !entry.inexact;
            const counts: ScopeCounts = {
                total: entry.total,
                highlight: entry.highlight,
                confidence: exact
                    ? CountConfidence.Exact
                    : entry.total > 0 || entry.highlight > 0
                      ? CountConfidence.LowerBound
                      : CountConfidence.Unknown,
            };
            if (scope === MAIN_SCOPE) {
                result.main = counts;
            } else {
                result.threads.set(scope, counts);
            }
        }
        return result;
    }

    /** The scope an event counts in, or undefined while the event it relates to is not known. */
    private scopeOf(event: LedgerEvent): string | undefined {
        let current: LedgerEventInput | undefined = event;
        // Relations can chain, such as a reaction to an edit; a few steps are enough, and stop any cycle.
        for (let step = 0; step < 4 && current; step++) {
            if (current.threadRoot) return current.threadRoot;
            if (!current.relatesTo) return MAIN_SCOPE;
            current = this.events.get(current.relatesTo);
        }
        return undefined;
    }

    /** The receipts, own events and join, gathered by scope. */
    private frontiers(): Map<string, Frontier> {
        const result = new Map<string, Frontier>();
        const note = (scope: string, eventId: string | undefined): void => {
            if (eventId === undefined) return;
            const frontier = result.get(scope) ?? { dangling: false };
            const event = this.events.get(eventId);
            if (!event) {
                frontier.dangling = true;
            } else if (!frontier.known || compare(event, frontier.known) > 0) {
                frontier.known = event;
            }
            result.set(scope, frontier);
        };
        for (const [scope, byKind] of this.receipts) {
            note(scope, byKind.public);
            note(scope, byKind.private);
        }
        // The user's own events read everything before them in their scope.
        let join: LedgerEvent | undefined;
        for (const event of this.events.values()) {
            if (event.own) note(this.scopeOf(event) ?? MAIN_SCOPE, event.id);
            if (event.joins && (!join || compare(event, join) > 0)) join = event;
        }
        if (this.joined) {
            if (join) {
                note(UNTHREADED_RECEIPT, join.id);
            } else {
                const frontier = result.get(UNTHREADED_RECEIPT) ?? { dangling: false };
                frontier.dangling = true;
                result.set(UNTHREADED_RECEIPT, frontier);
            }
        }
        return result;
    }

    /** The combined frontier of a scope: its own receipts and those covering every scope. */
    private frontierFor(scope: string, frontiers: Map<string, Frontier>): Frontier {
        const own = frontiers.get(scope);
        const shared = frontiers.get(UNTHREADED_RECEIPT);
        let known = own?.known;
        if (shared?.known && (!known || compare(shared.known, known) > 0)) known = shared.known;
        return { known, dangling: !!own?.dangling || !!shared?.dangling };
    }

    private readState(event: LedgerEvent, frontiers: Map<string, Frontier>): "read" | "unread" | "unresolved" {
        const frontier = this.frontierFor(this.scopeOf(event) ?? MAIN_SCOPE, frontiers);
        if (frontier.known && compare(event, frontier.known) <= 0) return "read";
        // A receipt not known yet could be anywhere. So could the join, when nothing else marks a start.
        if (!this.receiptsComplete) return "unresolved";
        if (!frontier.known && !frontier.dangling) return "unresolved";
        // A receipt whose event is not known is before the newest segment, but could be after an older one.
        if (frontier.dangling && event.segment !== this.liveSegment()) return "unresolved";
        return "unread";
    }

    private liveSegment(): Segment | undefined {
        return this.segments[this.segments.length - 1];
    }

    private newSegment(): Segment {
        const segment: Segment = { order: this.nextOrder++, events: [] };
        this.segments.push(segment);
        return segment;
    }

    private insertAt(segment: Segment, index: number, inputs: LedgerEventInput[]): void {
        const added = inputs.map((input) => this.toEvent(input, segment));
        segment.events.splice(index, 0, ...added);
        renumber(segment);
    }

    private toEvent(input: LedgerEventInput, segment: Segment): LedgerEvent {
        const event: LedgerEvent = { ...input, segment, position: 0, redacted: false };
        this.events.set(input.id, event);
        return event;
    }

    /**
     * Join a stretch with the segments it shares events with. Both are unbroken, so together they are too: the
     * oldest segment's events before the stretch, the stretch, then the newest segment's events after it.
     */
    private mergeRun(inputs: LedgerEventInput[], touched: Set<Segment>, live: boolean): void {
        const merged: LedgerEvent[] = [];
        const target: Segment = { order: 0, events: merged };
        // How far each touched segment has been copied: its events up to a known event of the stretch come first.
        const copied = new Map<Segment, number>();
        for (const segment of touched) copied.set(segment, 0);
        for (const input of inputs) {
            const known = this.events.get(input.id);
            if (!known) {
                merged.push(this.toEvent(input, target));
                continue;
            }
            const segment = known.segment;
            const from = copied.get(segment)!;
            // Positions are indexes until the segments are rebuilt below.
            const index = known.position;
            if (index < from) continue;
            merged.push(...segment.events.slice(from, index + 1));
            copied.set(segment, index + 1);
        }
        for (const segment of [...touched].sort((a, b) => a.order - b.order)) {
            merged.push(...segment.events.slice(copied.get(segment)));
        }
        const orders = [...touched].map((segment) => segment.order);
        // Sync's newest events always join the newest segment; history keeps the place of what it joined.
        target.order = live ? this.nextOrder++ : Math.max(...orders);
        this.segments = this.segments.filter((segment) => !touched.has(segment));
        this.segments.push(target);
        this.segments.sort((a, b) => a.order - b.order);
        for (const event of merged) event.segment = target;
        renumber(target);
    }

    /** Let go of the oldest events past the limit. */
    private trim(): void {
        let excess = this.events.size - MAX_EVENTS;
        while (excess > 0 && this.segments.length > 0) {
            const oldest = this.segments[0];
            const removed = oldest.events.splice(0, excess);
            for (const event of removed) this.events.delete(event.id);
            excess -= removed.length;
            if (oldest.events.length === 0) this.segments.shift();
        }
    }

    private forEachNewestFirst(callback: (event: LedgerEvent) => void): void {
        for (let s = this.segments.length - 1; s >= 0; s--) {
            const events = this.segments[s].events;
            for (let i = events.length - 1; i >= 0; i--) callback(events[i]);
        }
    }
}

function emptyCounts(): ScopeCounts {
    return { total: 0, highlight: 0, confidence: CountConfidence.Unknown };
}

function renumber(segment: Segment): void {
    segment.events.forEach((event, index) => (event.position = index));
}

/** Order two known events: negative when `a` comes first. */
function compare(a: LedgerEvent, b: LedgerEvent): number {
    return a.segment.order - b.segment.order || a.position - b.position;
}
