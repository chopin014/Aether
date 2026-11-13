/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";

import { SummarizedNotificationState } from "./SummarizedNotificationState";
import { StaticNotificationState } from "./StaticNotificationState";
import { NotificationLevel } from "./NotificationLevel";

/** A count that is only a lower bound, or approximate. */
class InexactState extends StaticNotificationState {
    public constructor(count: number, approximate = false) {
        super(null, count, NotificationLevel.Notification);
        this._countIsLowerBound = !approximate;
        this._countIsApproximate = approximate;
    }
}

describe("SummarizedNotificationState", () => {
    it("reports the unsent symbol when one of the summarized states failed to send", () => {
        const state = new SummarizedNotificationState();
        state.add(StaticNotificationState.forCount(12, NotificationLevel.Notification));
        state.add(new StaticNotificationState("!", 1, NotificationLevel.Unsent));

        expect(state.level).toBe(NotificationLevel.Unsent);
        expect(state.symbol).toBe("!");
    });

    it("keeps reporting the count when nothing failed to send", () => {
        const state = new SummarizedNotificationState();
        state.add(StaticNotificationState.forCount(12, NotificationLevel.Notification));

        expect(state.level).toBe(NotificationLevel.Notification);
        expect(state.symbol).toBeNull();
        expect(state.count).toBe(12);
    });

    it("sums to a lower bound when a count in it is one", () => {
        const state = new SummarizedNotificationState();
        state.add(StaticNotificationState.forCount(12, NotificationLevel.Notification));
        expect(state.countIsLowerBound).toBe(false);

        state.add(new InexactState(3));

        expect(state.count).toBe(15);
        expect(state.countIsLowerBound).toBe(true);
    });

    it("sums to an approximate count, no lower bound, when a count in it is approximate", () => {
        const state = new SummarizedNotificationState();
        state.add(new InexactState(2));
        state.add(new InexactState(5, true));
        // Added after, a lower bound does not make it one again.
        state.add(new InexactState(1));

        expect(state.count).toBe(8);
        expect(state.countIsLowerBound).toBe(false);
        expect(state.countIsApproximate).toBe(true);
    });

    it("still adopts an explicit symbol below the unsent level", () => {
        const state = new SummarizedNotificationState();
        state.add(StaticNotificationState.forSymbol("@", NotificationLevel.Highlight), true);

        expect(state.symbol).toBe("@");
    });
});
