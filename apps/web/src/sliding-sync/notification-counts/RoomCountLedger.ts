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
    /**
     * As last seen: some events counted were seen before a gap in what the ledger was given. They could have been
     * redacted in it, and it could hold more, so the count could be too high as well as too low.
     */
    LastKnown = "lastKnown",
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

/** One kind of receipt for one scope. */
export interface ReceiptPoints {
    /** The latest receipt whose event the ledger had when it arrived. */
    best?: string;
    /** The latest receipt from the server whose event the ledger did not have: before the newest segment. */
    dangling?: string;
    /**
     * Receipts made on this device for events the ledger did not have, oldest first. Each could be anywhere, even
     * after the newest event known, until its event arrives or the server's receipts supersede it.
     */
    local?: string[];
    /** More of `local` came than are kept: one let go could be anywhere too, until the server's receipt comes. */
    overflowed?: boolean;
}

/** How many receipts made on this device for events not seen are kept, per scope and kind. */
const MAX_LOCAL_RECEIPTS = 4;

/** Where the user's join is kept among the frontiers. */
const JOIN = "\u0000join";

/** How many redactions of events not seen yet are remembered, in case the events arrive later. */
const MAX_PENDING_REDACTIONS = 500;

/** One event as saved: its ID, then {@link SavedFlag}s, then its thread root and the event it relates to. */
export type SavedEvent = [id: string, flags: number, threadRoot?: string, relatesTo?: string];

/** What a ledger saves on this device, to be restored at the next start: see {@link RoomCountLedger.save}. */
export interface SavedLedger {
    version: typeof SAVED_VERSION;
    /** The newest events, by segment, oldest first. */
    segments: SavedEvent[][];
    /** By receipt scope, then kind. */
    receipts: Record<string, Partial<Record<ReceiptKind, ReceiptPoints>>>;
    receiptsComplete: boolean;
    /** What the events were evaluated with: see {@link RoomCountLedger.evaluatedWith}. */
    evaluatedWith?: string;
}

const SAVED_VERSION = 1;

/** The facts kept about a saved event, as bits. */
enum SavedFlag {
    Own = 1,
    Joins = 2,
    Redacted = 4,
    Evaluated = 8,
    Notify = 16,
    Highlight = 32,
    Final = 64,
}

/** How many of a room's newest events are saved. */
const SAVED_EVENTS = 300;

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

/** A scope's counts while they are worked out. */
interface Tally {
    total: number;
    highlight: number;
    /** Something that could count could not be checked. */
    inexact: boolean;
    /** Something counted was seen before a gap. */
    stale: boolean;
}

/** Where a read receipt or similar point sits, if the ledger knows its event. */
interface Frontier {
    /** The newest known point: everything up to it is read. */
    known?: LedgerEvent;
    /** A point whose event the ledger does not know, before the newest segment. */
    dangling: boolean;
    /** A point whose event the ledger does not know, which could be anywhere, even after the newest event known. */
    anywhere?: boolean;
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
 * ledger has not been given sits before the newest segment. The newest segment is unbroken up to the newest event,
 * and every event that reaches the room through sync or its history arrives here, so a receipt for an event in the
 * newest segment finds it. (Events fetched any other way, such as a thread's replies, come from before it.) Older
 * segments may come before or after such a receipt, so their events are neither read nor unread until more is known.
 *
 * A count is exact when there is no gap between its scope's newest receipt and the newest event, every receipt is
 * known, and every unread event there has been evaluated. Otherwise it is a lower bound of what is certainly unread,
 * or, when it counts events from before a gap that could have been redacted in it, what was last known.
 */
export class RoomCountLedger {
    private readonly events = new Map<string, LedgerEvent>();
    private segments: Segment[] = [];
    private nextOrder = 0;
    /** By receipt scope ("main", a thread root or {@link UNTHREADED_RECEIPT}), then kind. */
    private readonly receipts = new Map<string, Partial<Record<ReceiptKind, ReceiptPoints>>>();
    private receiptsComplete = false;
    private joined = false;
    /** Events redacted before the ledger was given them, oldest first. */
    private readonly pendingRedactions = new Set<string>();
    /**
     * What the events' contributions were worked out with, such as a fingerprint of the push rules and of what they
     * read about the room, as set by whoever evaluates them. Saved and restored with the ledger, so a change while
     * away is noticed.
     */
    public evaluatedWith?: string;

    /**
     * A ledger as saved by {@link save}, or undefined when what was saved cannot be read, such as one saved by an
     * older version.
     */
    public static restore(saved: SavedLedger | undefined): RoomCountLedger | undefined {
        if (saved?.version !== SAVED_VERSION || !Array.isArray(saved.segments)) return undefined;
        const ledger = new RoomCountLedger();
        for (const events of saved.segments) {
            const segment = ledger.newSegment();
            for (const [id, flags, threadRoot, relatesTo] of events) {
                if (typeof id !== "string" || ledger.events.has(id)) continue;
                const event = ledger.toEvent(
                    {
                        id,
                        own: (flags & SavedFlag.Own) !== 0,
                        joins: (flags & SavedFlag.Joins) !== 0 || undefined,
                        threadRoot: threadRoot || undefined,
                        relatesTo: relatesTo || undefined,
                    },
                    segment,
                );
                event.redacted = (flags & SavedFlag.Redacted) !== 0;
                if (flags & SavedFlag.Evaluated) {
                    event.contribution = {
                        notify: (flags & SavedFlag.Notify) !== 0,
                        highlight: (flags & SavedFlag.Highlight) !== 0,
                        final: (flags & SavedFlag.Final) !== 0,
                    };
                }
                segment.events.push(event);
            }
            renumber(segment);
        }
        ledger.segments = ledger.segments.filter((segment) => segment.events.length > 0);
        for (const [scope, byKind] of Object.entries(saved.receipts ?? {})) {
            const kinds: Partial<Record<ReceiptKind, ReceiptPoints>> = {};
            for (const kind of ["public", "private"] as const) {
                const points = byKind?.[kind];
                if (!points) continue;
                kinds[kind] = {
                    best: typeof points.best === "string" ? points.best : undefined,
                    dangling: typeof points.dangling === "string" ? points.dangling : undefined,
                    local: Array.isArray(points.local)
                        ? points.local.filter((id): id is string => typeof id === "string")
                        : undefined,
                    overflowed: points.overflowed === true || undefined,
                };
            }
            ledger.receipts.set(scope, kinds);
        }
        ledger.receiptsComplete = saved.receiptsComplete === true;
        ledger.evaluatedWith = typeof saved.evaluatedWith === "string" ? saved.evaluatedWith : undefined;
        return ledger;
    }

    /**
     * What to save of this ledger: the newest events and every receipt. Older events are left out as {@link trim}
     * lets them go, from the oldest end, so a restored ledger never claims more than it knows.
     */
    public save(): SavedLedger {
        const segments: SavedEvent[][] = [];
        let room = SAVED_EVENTS;
        for (let s = this.segments.length - 1; s >= 0 && room > 0; s--) {
            const events = this.segments[s].events.slice(-room);
            room -= events.length;
            segments.unshift(events.map(saveEvent));
        }
        const receipts: SavedLedger["receipts"] = {};
        for (const [scope, byKind] of this.receipts) {
            receipts[scope] = {};
            for (const kind of ["public", "private"] as const) {
                const points = byKind[kind];
                if (points) receipts[scope][kind] = { ...points, local: points.local && [...points.local] };
            }
        }
        return {
            version: SAVED_VERSION,
            segments,
            receipts,
            receiptsComplete: this.receiptsComplete,
            evaluatedWith: this.evaluatedWith,
        };
    }

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

    /** Forget what one event adds, so it is evaluated again: for when it was decrypted. */
    public forgetContribution(eventId: string): void {
        const event = this.events.get(eventId);
        if (event) event.contribution = undefined;
    }

    /**
     * Record that an event was redacted, or that a pending redaction of it was undone. A redaction of an event the
     * ledger does not have is remembered for when the event arrives.
     */
    public setRedacted(eventId: string, redacted: boolean): void {
        const event = this.events.get(eventId);
        if (event) {
            event.redacted = redacted;
        } else if (redacted) {
            this.pendingRedactions.add(eventId);
            if (this.pendingRedactions.size > MAX_PENDING_REDACTIONS) {
                this.pendingRedactions.delete(this.pendingRedactions.values().next().value!);
            }
        } else {
            this.pendingRedactions.delete(eventId);
        }
    }

    /**
     * Record one of the user's read receipts.
     * @param scope - The receipt's thread: "main", a thread root, or {@link UNTHREADED_RECEIPT}.
     * @param kind - Public (`m.read`) or private (`m.read.private`). Both mark events read.
     * @param eventId - The event read up to.
     * @param fromServer - False for a receipt made on this device. The server sends its receipts with the events they
     * could be for, so one whose event the ledger does not have is before the newest segment. One made here is for
     * an event this device showed, which could be newer than anything sync brought, such as one opened from a link
     * while sync was behind: it reads nothing for certain until its event arrives, or the server sends its own
     * receipt of that kind for the scope, which takes the place of every one made here (an echo of it, or a newer
     * one that the server kept instead).
     */
    public setReceipt(scope: string, kind: ReceiptKind, eventId: string, fromServer = true): void {
        const byKind = this.receipts.get(scope) ?? {};
        const points = byKind[kind] ?? {};
        const keepLater = (id: string): void => {
            const event = this.events.get(id);
            const best = points.best !== undefined ? this.events.get(points.best) : undefined;
            // A receipt never moves back: of two known events, the later stays.
            if (event && (!best || compare(event, best) > 0)) points.best = id;
        };
        // Ones that could not be placed when they came may have been since, such as by history filling a gap: they
        // are kept as known ones before anything replaces them.
        if (points.dangling !== undefined && this.events.has(points.dangling)) {
            keepLater(points.dangling);
            points.dangling = undefined;
        }
        points.local = points.local?.filter((id) => {
            if (!this.events.has(id)) return true;
            keepLater(id);
            return false;
        });
        if (fromServer) {
            points.local = undefined;
            points.overflowed = undefined;
        }
        if (this.events.has(eventId)) {
            keepLater(eventId);
        } else if (fromServer) {
            // Kept beside the known one rather than replacing it: it cannot be placed against it.
            points.dangling = eventId;
        } else {
            // Kept beside the others too: an older one, such as for an event opened from a link, must not undo a
            // newer one.
            const local = (points.local ?? []).filter((id) => id !== eventId);
            local.push(eventId);
            if (local.length > MAX_LOCAL_RECEIPTS) points.overflowed = true;
            points.local = local.slice(-MAX_LOCAL_RECEIPTS);
        }
        if (points.local?.length === 0) points.local = undefined;
        byKind[kind] = points;
        this.receipts.set(scope, byKind);
    }

    /**
     * Drop the receipts made on this device for events not seen: the server has just sent every receipt the user
     * has in the room, which would include them had it kept them.
     */
    public dropLocalReceipts(): void {
        for (const byKind of this.receipts.values()) {
            for (const points of [byKind.public, byKind.private]) {
                if (!points) continue;
                points.local = undefined;
                points.overflowed = undefined;
            }
        }
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

    /**
     * Events that could count and have not been evaluated, newest first, so they can be. One evaluated as far as it
     * can be, such as an encrypted event not yet decrypted, waits until it is forgotten again.
     */
    public unevaluated(): string[] {
        return this.collectUnevaluated();
    }

    /**
     * Where history would make the main timeline's count exact: the first event of the newest segment, when a gap
     * lies between it and the user's newest receipt there (one in an older segment, or one whose event the ledger
     * does not have). History fetched just before it fills the gap, or reaches the receipt. Undefined when no gap
     * matters, or while the receipts are not all known yet.
     */
    public recoveryAnchor(): string | undefined {
        if (!this.receiptsComplete) return undefined;
        const live = this.liveSegment();
        if (!live) return undefined;
        const frontier = this.frontierFor(MAIN_SCOPE, this.frontiers());
        // A receipt made here for an event not seen settles otherwise.
        if (frontier.anywhere) return undefined;
        if (frontier.known?.segment === live) return undefined;
        if (!frontier.known && !frontier.dangling) return undefined;
        return live.events[0]?.id;
    }

    private collectUnevaluated(): string[] {
        const result: string[] = [];
        const frontiers = this.frontiers();
        this.forEachNewestFirst((event) => {
            if (event.own || event.redacted || event.contribution) return;
            if (this.readState(event, frontiers) !== "read") result.push(event.id);
        });
        return result;
    }

    /** Work out the counts from what the ledger knows now. */
    public compute(): RoomCounts {
        const frontiers = this.frontiers();
        const live = this.liveSegment();
        const tallies = new Map<string, Tally>();
        const tally = (scope: string): Tally => {
            let entry = tallies.get(scope);
            if (!entry) {
                entry = { total: 0, highlight: 0, inexact: false, stale: false };
                tallies.set(scope, entry);
            }
            return entry;
        };
        tally(MAIN_SCOPE);
        // Whether an event that could count has no scope known yet, so could belong to any.
        let unrouted = false;

        this.forEachNewestFirst((event) => {
            const routed = this.scopeOf(event);
            if (event.own || event.redacted) {
                if (routed) tally(routed);
                return;
            }
            if (!routed) {
                // Such as a reaction to an event not seen: unless a receipt covering every scope reads it, it could
                // count anywhere, so it counts nowhere until its scope is known.
                if (this.readState(event, frontiers, UNTHREADED_RECEIPT) === "read") return;
                const contribution = event.contribution;
                if (!contribution?.final || contribution.notify || contribution.highlight) unrouted = true;
                return;
            }
            const entry = tally(routed);
            const state = this.readState(event, frontiers);
            if (state === "read") return;
            const contribution = event.contribution;
            if (!contribution?.final) {
                entry.inexact = true;
                return;
            }
            if (!contribution.notify && !contribution.highlight) return;
            if (state === "unresolved") {
                entry.inexact = true;
                return;
            }
            // Seen before a gap, it could have been redacted in the gap: it counts as last seen.
            if (event.segment !== live) entry.stale = true;
            if (contribution.notify) entry.total++;
            if (contribution.highlight) entry.highlight++;
        });

        const result: RoomCounts = { main: emptyCounts(), threads: new Map() };
        for (const [scope, entry] of tallies) {
            const frontier = this.frontierFor(scope, frontiers);
            // Exact needs the newest receipt in the newest segment: then there is no gap after it.
            const covered =
                this.receiptsComplete && !frontier.anywhere && !!frontier.known && frontier.known.segment === live;
            const exact = covered && !entry.inexact && !entry.stale && !unrouted;
            let confidence = CountConfidence.Unknown;
            if (exact) {
                confidence = CountConfidence.Exact;
            } else if (entry.stale) {
                confidence = CountConfidence.LastKnown;
            } else if (entry.total > 0 || entry.highlight > 0) {
                confidence = CountConfidence.LowerBound;
            }
            const counts: ScopeCounts = { total: entry.total, highlight: entry.highlight, confidence };
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
        const note = (scope: string, eventId: string | undefined, local = false): void => {
            if (eventId === undefined) return;
            const frontier = result.get(scope) ?? { dangling: false };
            const event = this.events.get(eventId);
            if (!event) {
                if (local) {
                    frontier.anywhere = true;
                } else {
                    frontier.dangling = true;
                }
            } else if (!frontier.known || compare(event, frontier.known) > 0) {
                frontier.known = event;
            }
            result.set(scope, frontier);
        };
        for (const [scope, byKind] of this.receipts) {
            for (const points of [byKind.public, byKind.private]) {
                note(scope, points?.best);
                note(scope, points?.dangling);
                for (const id of points?.local ?? []) note(scope, id, true);
                if (points?.overflowed) {
                    const frontier = result.get(scope) ?? { dangling: false };
                    frontier.anywhere = true;
                    result.set(scope, frontier);
                }
            }
        }
        // The user's own events read everything before them in their scope.
        let join: LedgerEvent | undefined;
        for (const event of this.events.values()) {
            // One whose scope is not known yet, such as a reaction to an event not seen, reads nothing until it is.
            const scope = event.own ? this.scopeOf(event) : undefined;
            if (scope) note(scope, event.id);
            if (event.joins && (!join || compare(event, join) > 0)) join = event;
        }
        if (this.joined) result.set(JOIN, { known: join, dangling: !join });
        return result;
    }

    /**
     * The combined frontier of a scope: its own receipts and those covering every scope, then the user's join. A join
     * the ledger does not have only marks a start when nothing else does: a receipt or the user's own event shows
     * they were joined then.
     */
    private frontierFor(scope: string, frontiers: Map<string, Frontier>): Frontier {
        const own = frontiers.get(scope);
        const shared = frontiers.get(UNTHREADED_RECEIPT);
        const join = frontiers.get(JOIN);
        let known = own?.known;
        for (const other of [shared?.known, join?.known]) {
            if (other && (!known || compare(other, known) > 0)) known = other;
        }
        const dangling = !!own?.dangling || !!shared?.dangling || (!known && !!join?.dangling);
        return { known, dangling, anywhere: !!own?.anywhere || !!shared?.anywhere };
    }

    /**
     * Whether an event is read in its scope.
     * @param scope - The scope to judge it in, if not its own: {@link UNTHREADED_RECEIPT} judges it only by what
     * covers every scope.
     */
    private readState(
        event: LedgerEvent,
        frontiers: Map<string, Frontier>,
        scope = this.scopeOf(event) ?? MAIN_SCOPE,
    ): "read" | "unread" | "unresolved" {
        const frontier = this.frontierFor(scope, frontiers);
        if (frontier.known && compare(event, frontier.known) <= 0) return "read";
        // A receipt not known yet could be anywhere. So could the join, when nothing else marks a start.
        if (!this.receiptsComplete || frontier.anywhere) return "unresolved";
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
        const redacted = this.pendingRedactions.delete(input.id);
        const event: LedgerEvent = { ...input, segment, position: 0, redacted };
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

/**
 * A saved ledger with only its newest events, dropped from the oldest end as a ledger lets them go.
 * @param saved - The saved ledger.
 * @param limit - How many events to keep.
 */
export function trimSavedLedger(saved: SavedLedger, limit: number): SavedLedger {
    let room = limit;
    const segments: SavedEvent[][] = [];
    for (let s = saved.segments.length - 1; s >= 0 && room > 0; s--) {
        const events = saved.segments[s].slice(-room);
        room -= events.length;
        segments.unshift(events);
    }
    return { ...saved, segments };
}

function saveEvent(event: LedgerEvent): SavedEvent {
    let flags = 0;
    if (event.own) flags |= SavedFlag.Own;
    if (event.joins) flags |= SavedFlag.Joins;
    if (event.redacted) flags |= SavedFlag.Redacted;
    const contribution = event.contribution;
    if (contribution) {
        flags |= SavedFlag.Evaluated;
        if (contribution.notify) flags |= SavedFlag.Notify;
        if (contribution.highlight) flags |= SavedFlag.Highlight;
        if (contribution.final) flags |= SavedFlag.Final;
    }
    const saved: SavedEvent = [event.id, flags];
    if (event.threadRoot || event.relatesTo) saved.push(event.threadRoot ?? "");
    if (event.relatesTo) saved.push(event.relatesTo);
    return saved;
}

function renumber(segment: Segment): void {
    segment.events.forEach((event, index) => (event.position = index));
}

/** Order two known events: negative when `a` comes first. */
function compare(a: LedgerEvent, b: LedgerEvent): number {
    return a.segment.order - b.segment.order || a.position - b.position;
}
