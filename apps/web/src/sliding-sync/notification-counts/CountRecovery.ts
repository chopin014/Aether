/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    Direction,
    EventTimeline,
    KnownMembership,
    type MatrixClient,
    MatrixError,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { noUnsafeEventProps } from "matrix-js-sdk/src/utils";

/** How much history recovery fetches. */
export interface CountRecoveryLimits {
    /** How many history requests run at once. */
    concurrent: number;
    /** Events asked for per request. */
    pageSize: number;
    /** Requests for one gap of a room before giving up on it. */
    pagesPerGap: number;
    /** Requests in all for a session: rooms past it keep counts that are not exact. */
    sessionPages: number;
    /** Roughly how much history in all for a session, in bytes of event JSON. */
    sessionBytes: number;
}

const DEFAULT_LIMITS: CountRecoveryLimits = {
    concurrent: 2,
    pageSize: 50,
    pagesPerGap: 2,
    sessionPages: 20,
    sessionBytes: 5 * 1024 * 1024,
};

/** How long to wait after the server asks to slow down, when it does not say, in milliseconds. */
const DEFAULT_BACKOFF_MS = 5000;

/** What the engine gives the recovery to work with. */
export interface CountRecoveryHost {
    /** Where history would make a room's count exact, or undefined when nothing needs it now. */
    recoveryAnchor(roomId: string): string | undefined;
    /** Take a page of a room's history, oldest first, that comes just before `anchor`. */
    addHistory(room: Room, events: MatrixEvent[], anchor: string): void;
}

interface Job {
    roomId: string;
    /** The event the next page comes just before, which starts the room's newest segment while the gap is open. */
    anchor: string;
    /** The pagination token for history before `anchor`. */
    token: string;
    pages: number;
}

/**
 * Fills the gaps that keep a room's count from being exact, such as a room the server sent only its newest message
 * of, with a little of its history. The pages go only to the count, not to the room's timeline, so nothing is
 * shown or notified again.
 *
 * It does a bounded amount of work, and only once {@link allow}ed, after the room list has found every room: the
 * most recently active rooms first, a few pages per gap, a couple of requests at a time, and a small allowance of
 * pages and bytes for the session, so a large account never fetches the history of every room. Rooms past the
 * allowance keep a count that says it is not exact.
 *
 * Each room has at most one job waiting and one under way. A newer gap takes the place of the one waiting, or
 * follows the one under way. Work for a gap that has gone, or a room the user left, is dropped without spending
 * any of the allowance, and a page that comes back for such a gap is not used.
 */
export class CountRecovery {
    /** Jobs waiting, by room. */
    private readonly waiting = new Map<string, Job>();
    /** Jobs under way, by room. */
    private readonly running = new Map<string, Job>();
    /** Gaps given up on, by room, so a room is not asked for again until its gap changes. */
    private readonly settled = new Map<string, string>();
    private readonly limits: CountRecoveryLimits;
    private pagesLeft: number;
    private bytesLeft: number;
    private allowed = false;
    private pumping = false;
    private pausedUntil = 0;
    private stopped = false;
    private wakeTimer?: ReturnType<typeof setTimeout>;

    public constructor(
        private readonly client: MatrixClient,
        private readonly host: CountRecoveryHost,
        limits: Partial<CountRecoveryLimits> = {},
    ) {
        this.limits = { ...DEFAULT_LIMITS, ...limits };
        this.pagesLeft = this.limits.sessionPages;
        this.bytesLeft = this.limits.sessionBytes;
    }

    /** Start fetching: until then, gaps asked for wait, so finding the account's rooms is not slowed down. */
    public allow(): void {
        this.allowed = true;
        this.pump();
    }

    /** Ask for a room's gap to be filled, if it is worth it and not asked for already. */
    public request(room: Room, anchor: string): void {
        if (this.stopped || this.exhausted()) return;
        if (room.getMyMembership() !== KnownMembership.Join) return;
        if (this.settled.get(room.roomId) === anchor) return;
        // Asked for a gap that has gone meanwhile, such as one a page already filled.
        if (this.host.recoveryAnchor(room.roomId) !== anchor) return;
        // One under way is followed by this, if it is still wanted then.
        if (this.running.has(room.roomId)) return;
        if (this.waiting.get(room.roomId)?.anchor === anchor) return;
        const token = backwardToken(room, anchor);
        // Without a token now, it may have one when asked again, such as after the server's next response.
        if (!token) return;
        // A newer gap takes the place of one waiting.
        this.waiting.set(room.roomId, { roomId: room.roomId, anchor, token, pages: 0 });
        this.pump();
    }

    /** Stop fetching; requests under way finish but change nothing more. */
    public stop(): void {
        this.stopped = true;
        this.waiting.clear();
        if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
    }

    private exhausted(): boolean {
        return this.pagesLeft <= 0 || this.bytesLeft <= 0;
    }

    private pump(): void {
        if (this.stopped || !this.allowed || this.pumping) return;
        const wait = this.pausedUntil - Date.now();
        if (wait > 0) {
            this.wakeTimer ??= setTimeout(() => {
                this.wakeTimer = undefined;
                this.pump();
            }, wait);
            return;
        }
        this.pumping = true;
        try {
            // Work no longer needed goes in one pass, and the room's gap now, if any, takes its place.
            const obsolete = [...this.waiting.values()].filter((job) => !this.stillNeeded(job));
            for (const job of obsolete) this.waiting.delete(job.roomId);
            for (const job of obsolete) this.requestCurrent(job.roomId);
            while (this.running.size < this.limits.concurrent && this.waiting.size > 0 && !this.exhausted()) {
                const job = this.takeNext();
                this.running.set(job.roomId, job);
                this.pagesLeft--;
                void this.fetch(job).finally(() => {
                    this.running.delete(job.roomId);
                    // A newer gap asked for meanwhile follows.
                    this.requestCurrent(job.roomId);
                    this.pump();
                });
            }
        } finally {
            this.pumping = false;
        }
    }

    /** The waiting job of the most recently active room. */
    private takeNext(): Job {
        let best: Job | undefined;
        let bestActivity = -Infinity;
        for (const job of this.waiting.values()) {
            const activity = this.activity(job.roomId);
            if (activity > bestActivity) {
                best = job;
                bestActivity = activity;
            }
        }
        this.waiting.delete(best!.roomId);
        return best!;
    }

    private activity(roomId: string): number {
        const room = this.client.getRoom(roomId);
        return room?.getBumpStamp() ?? room?.getLastActiveTimestamp() ?? 0;
    }

    /** Whether the user is still in the room and its gap is still the one the job is for. */
    private stillNeeded(job: Job): boolean {
        const room = this.client.getRoom(job.roomId);
        if (room?.getMyMembership() !== KnownMembership.Join) return false;
        return this.host.recoveryAnchor(job.roomId) === job.anchor;
    }

    /** Ask for a room's gap as it is now, if it has one. */
    private requestCurrent(roomId: string): void {
        if (this.waiting.has(roomId) || this.running.has(roomId)) return;
        const room = this.client.getRoom(roomId);
        const anchor = this.host.recoveryAnchor(roomId);
        if (room && anchor !== undefined) this.request(room, anchor);
    }

    private async fetch(job: Job): Promise<void> {
        let events: MatrixEvent[];
        let next: string | undefined;
        try {
            const response = await this.client.createMessagesRequest(
                job.roomId,
                job.token,
                this.limits.pageSize,
                Direction.Backward,
            );
            this.bytesLeft -= JSON.stringify(response.chunk).length;
            const mapper = this.client.getEventMapper();
            // Newest first from the server: the ledger takes them oldest first.
            events = response.chunk.filter(noUnsafeEventProps).map(mapper).reverse();
            next = response.end && response.end !== job.token ? response.end : undefined;
        } catch (error) {
            if (error instanceof MatrixError && error.isRateLimitError()) {
                // Asked to slow down: this room waits its turn again, unless a newer gap took its place.
                let retryAfter: number | null = null;
                try {
                    retryAfter = error.getRetryAfterMs();
                } catch {
                    // A Retry-After the SDK cannot read: the default wait.
                }
                this.pausedUntil = Date.now() + (retryAfter ?? DEFAULT_BACKOFF_MS);
                this.pagesLeft++;
                if (!this.stopped && !this.waiting.has(job.roomId)) this.waiting.set(job.roomId, job);
                return;
            }
            // Asked for again as the room's counts are next published, within the same allowance.
            logger.warn(`Notification counts: could not fetch history of ${job.roomId}`, error);
            return;
        }
        // Stopped, left, or the gap filled or moved meanwhile, such as by a receipt or a newer sync: the page is
        // not used. A gap there is now is asked for once this job is done.
        const room = this.client.getRoom(job.roomId);
        if (this.stopped || !room || !this.stillNeeded(job)) return;
        if (events.length > 0) this.host.addHistory(room, events, job.anchor);
        job.pages++;
        const anchor = this.host.recoveryAnchor(job.roomId);
        // Filled.
        if (anchor === undefined) return;
        // The page joined the newest segment, which now starts with its oldest event; a page with no events the
        // client sees leaves the anchor where it was. Either way, the gap is still just before it.
        const expected = events[0]?.getId() ?? job.anchor;
        if (anchor !== expected) {
            // The page did not join the gap's segment: given up on until it changes.
            if (anchor === job.anchor) this.settled.set(job.roomId, anchor);
            return;
        }
        if (next && job.pages < this.limits.pagesPerGap && !this.exhausted()) {
            this.waiting.set(job.roomId, { ...job, anchor, token: next });
            return;
        }
        // History ends here, or this gap has had its pages: given up on until it changes.
        this.settled.set(job.roomId, anchor);
    }
}

/** The token for history just before an event, from the room timeline that starts with it. */
function backwardToken(room: Room, eventId: string): string | undefined {
    const timeline = room.getTimelineForEvent(eventId);
    if (!timeline || timeline.getEvents()[0]?.getId() !== eventId) return undefined;
    return timeline.getPaginationToken(EventTimeline.BACKWARDS) ?? undefined;
}
