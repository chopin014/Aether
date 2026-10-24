/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
    ACTIVE_WITHIN_MS,
    RECENT_WITHIN_MS,
    activityLabel,
    classifyActivity,
    msUntilLevelChange,
} from "./activityHint";

const MIN = 60 * 1000;

describe("activityHint", () => {
    it("classifies by age at the 5 and 30 minute boundaries", () => {
        expect(classifyActivity(0)).toBe("active");
        expect(classifyActivity(ACTIVE_WITHIN_MS - 1)).toBe("active");
        expect(classifyActivity(ACTIVE_WITHIN_MS)).toBe("recent");
        expect(classifyActivity(RECENT_WITHIN_MS - 1)).toBe("recent");
        expect(classifyActivity(RECENT_WITHIN_MS)).toBe("inactive");
    });

    it("says when the level will next change", () => {
        expect(msUntilLevelChange(MIN)).toBe(4 * MIN);
        expect(msUntilLevelChange(10 * MIN)).toBe(20 * MIN);
        expect(msUntilLevelChange(RECENT_WITHIN_MS)).toBeUndefined();
    });

    it("labels activity as activity, never as presence", () => {
        expect(activityLabel(10 * 1000)).toBe("Active now");
        expect(activityLabel(12 * MIN)).toBe("Active 12m ago");
        expect(activityLabel(3 * 60 * MIN)).toBe("Last active 3h ago");
        expect(activityLabel(2 * 24 * 60 * MIN)).toBe("Last active 2d ago");
    });
});
