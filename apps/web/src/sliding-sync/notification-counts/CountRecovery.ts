/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    Direction,
    EventTimeline,
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
}

const DEFAULT_LIMITS: CountRecoveryLimits = { concurrent: 2, pageSize: 50, pagesPerGap: 2, sessionPages: 200 };
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
    /** The event the next page comes just before. */
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
 * It does a bounded amount of work: a few pages per gap, a couple of requests at a time, and a budget for the
 * session, so a large account never fetches the history of every room. Rooms past the budget keep a count that
 * says it is not exact.
 */
export class CountRecovery {
    private readonly queue: Job[] = [];
    /** Rooms queued or being fetched, by the anchor they were asked for. */
    private readonly active = new Map<string, string>();
    /** Gaps given up on, by room, so a room is not asked for again until its gap changes. */
    private readonly settled = new Map<string, string>();
    private running = 0;
    private readonly limits: CountRecoveryLimits;
    private pagesLeft: number;
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
    }

    /** Ask for a room's gap to be filled, if it is worth it and not asked for already. */
    public request(room: Room, anchor: string): void {
        if (this.stopped || this.pagesLeft <= 0) return;
        if (this.active.has(room.roomId) || this.settled.get(room.roomId) === anchor) return;
        // Asked for a gap that has gone meanwhile, such as one a page already filled.
        if (this.host.recoveryAnchor(room.roomId) !== anchor) return;
        const token = backwardToken(room, anchor);
        if (!token) {
            this.settled.set(room.roomId, anchor);
            return;
        }
        this.active.set(room.roomId, anchor);
        this.queue.push({ roomId: room.roomId, anchor, token, pages: 0 });
        this.pump();
    }

    /** Stop fetching; requests under way finish but change nothing more. */
    public stop(): void {
        this.stopped = true;
        this.queue.length = 0;
        if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
    }

    private pump(): void {
        if (this.stopped) return;
        const wait = this.pausedUntil - Date.now();
        if (wait > 0) {
            this.wakeTimer ??= setTimeout(() => {
                this.wakeTimer = undefined;
                this.pump();
            }, wait);
            return;
        }
        while (this.running < this.limits.concurrent && this.queue.length > 0 && this.pagesLeft > 0) {
            const job = this.queue.shift()!;
            this.running++;
            this.pagesLeft--;
            void this.fetch(job).finally(() => {
                this.running--;
                this.pump();
            });
        }
    }

    private async fetch(job: Job): Promise<void> {
        const room = this.client.getRoom(job.roomId);
        if (!room) {
            this.active.delete(job.roomId);
            return;
        }
        let events: MatrixEvent[];
        let next: string | undefined;
        try {
            const response = await this.client.createMessagesRequest(
                job.roomId,
                job.token,
                this.limits.pageSize,
                Direction.Backward,
            );
            const mapper = this.client.getEventMapper();
            // Newest first from the server: the ledger takes them oldest first.
            events = response.chunk.filter(noUnsafeEventProps).map(mapper).reverse();
            next = response.end && response.end !== job.token ? response.end : undefined;
        } catch (error) {
            if (error instanceof MatrixError && error.isRateLimitError()) {
                // Asked to slow down: this room waits its turn again.
                let retryAfter: number | null = null;
                try {
                    retryAfter = error.getRetryAfterMs();
                } catch {
                    // A Retry-After the SDK cannot read: the default wait.
                }
                this.pausedUntil = Date.now() + (retryAfter ?? DEFAULT_BACKOFF_MS);
                this.pagesLeft++;
                this.queue.unshift(job);
                return;
            }
            logger.warn(`Notification counts: could not fetch history of ${job.roomId}`, error);
            this.settle(job);
            return;
        }
        if (this.stopped) return;
        if (events.length > 0) this.host.addHistory(room, events, job.anchor);
        job.pages++;
        const anchor = this.host.recoveryAnchor(job.roomId);
        this.active.delete(job.roomId);
        // Filled, or no longer needed.
        if (anchor === undefined) return;
        // The page joined the newest segment and the gap is still before it: carry on before its oldest event.
        const oldest = events[0]?.getId();
        if (anchor === oldest && next) {
            if (job.pages < this.limits.pagesPerGap) {
                this.active.set(job.roomId, anchor);
                this.queue.push({ ...job, anchor, token: next });
            } else {
                this.settled.set(job.roomId, anchor);
            }
            return;
        }
        // Another gap now, such as one a newer sync made: asked for again as the room's counts are published.
        if (anchor !== job.anchor && anchor !== oldest) return;
        this.settle(job);
    }

    /** Give up on a room's gap until it changes. */
    private settle(job: Job): void {
        this.active.delete(job.roomId);
        const anchor = this.host.recoveryAnchor(job.roomId);
        if (anchor !== undefined) this.settled.set(job.roomId, anchor);
    }
}

/** The token for history just before an event, from the room timeline that starts with it. */
function backwardToken(room: Room, eventId: string): string | undefined {
    const timeline = room.getTimelineForEvent(eventId);
    if (!timeline || timeline.getEvents()[0]?.getId() !== eventId) return undefined;
    return timeline.getPaginationToken(EventTimeline.BACKWARDS) ?? undefined;
}
