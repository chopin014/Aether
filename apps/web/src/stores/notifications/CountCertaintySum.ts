/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** A count, with how far it can be trusted. */
export interface CertainCount {
    count: number;
    /** Whether the count is only a lower bound: more could be unread than it says. */
    countIsLowerBound: boolean;
    /** Whether the count is approximate, as last seen: it could be too high, as well as too low. */
    countIsApproximate: boolean;
}

/**
 * How far a sum of counts can be trusted, as counts are added to it. It is approximate if one of its counts is, as
 * that one could be too high; otherwise only a lower bound if one of them is; otherwise exact. A count of zero adds
 * no doubt: one that is not exact, such as a Space's, which has no history, would put doubt on every sum.
 */
export class CountCertaintySum {
    private lowerBound = false;
    private approximate = false;

    /** Add a count to the sum. */
    public add(count: CertainCount): void {
        if (count.count <= 0) return;
        if (count.countIsApproximate) this.approximate = true;
        if (count.countIsLowerBound) this.lowerBound = true;
    }

    /** Whether the sum is only a lower bound. */
    public get countIsLowerBound(): boolean {
        return this.lowerBound && !this.approximate;
    }

    /** Whether the sum is approximate. */
    public get countIsApproximate(): boolean {
        return this.approximate;
    }
}
