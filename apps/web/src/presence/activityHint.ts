/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { formatDuration } from "../DateUtils";
import { _t } from "../languageHandler";

/** Activity newer than this is shown green. */
export const ACTIVE_WITHIN_MS = 5 * 60 * 1000;

/** Activity newer than this, but not {@link ACTIVE_WITHIN_MS}, is shown amber. */
export const RECENT_WITHIN_MS = 30 * 60 * 1000;

const JUST_NOW_MS = 60 * 1000;

/** How recently someone did something visible to us. This is not their real presence. */
export type ActivityLevel = "active" | "recent" | "inactive";

/** Sort a last-activity age into the level that decides the dot colour. */
export function classifyActivity(ageMs: number): ActivityLevel {
    if (ageMs < ACTIVE_WITHIN_MS) return "active";
    if (ageMs < RECENT_WITHIN_MS) return "recent";
    return "inactive";
}

/**
 * The next moment, as a delay from now, at which the level of an activity time changes by itself.
 * Undefined once it can no longer change.
 */
export function msUntilLevelChange(ageMs: number): number | undefined {
    if (ageMs < ACTIVE_WITHIN_MS) return ACTIVE_WITHIN_MS - ageMs;
    if (ageMs < RECENT_WITHIN_MS) return RECENT_WITHIN_MS - ageMs;
    return undefined;
}

/** Wording that says what we saw rather than claiming a status: "Active now", "Active 12m ago", "Last active 3h ago". */
export function activityLabel(ageMs: number): string {
    if (ageMs < JUST_NOW_MS) return _t("presence|active_now");
    const duration = formatDuration(ageMs);
    if (ageMs < RECENT_WITHIN_MS) return _t("presence|active_ago", { duration });
    return _t("presence|last_active_ago", { duration });
}
