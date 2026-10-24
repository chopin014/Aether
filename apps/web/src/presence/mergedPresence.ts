/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { formatDuration } from "../DateUtils";
import { _t } from "../languageHandler";
import { type AetherPresenceSignal } from "./AetherPresenceStore";
import { activityLabel, classifyActivity } from "./activityHint";

/** Where a status came from, strongest first. */
export type PresenceSource = "server" | "aether" | "activity";

/** The statuses a dot can show. */
export type MergedPresenceState = "online" | "unavailable" | "busy" | "offline";

/** The status to show for a user, and the evidence behind it. */
export interface MergedPresence {
    state: MergedPresenceState;
    source: PresenceSource;
    /**
     * Wording for the tooltip and screen readers when the default for `state` would overstate what is known:
     * activity hints and expired Aether signals. Absent means use the standard "Online"/"Away"/… names.
     */
    label?: string;
}

/**
 * Combine the available evidence about one user. Real server presence always wins, then an Aether signal, then
 * what we last saw the user do. An Aether signal that has run out loses to activity seen after it was sent, since
 * that is newer information. With no evidence at all the result is null and no dot is shown.
 */
export function mergePresence(input: {
    server?: MergedPresenceState;
    aether?: AetherPresenceSignal;
    /** When the user was last seen doing something, in milliseconds since the epoch. */
    lastActive?: number;
    now: number;
}): MergedPresence | null {
    const { server, aether, lastActive, now } = input;
    if (server) return { state: server, source: "server" };

    const activityNewer = lastActive !== undefined && (!aether || lastActive > aether.lastSeen);
    if (aether && !(aether.expired && activityNewer)) {
        return {
            state: aether.presence,
            source: "aether",
            ...(aether.expired
                ? {
                      label: _t("presence|offline_last_seen", {
                          duration: formatDuration(Math.max(0, now - aether.lastSeen)),
                      }),
                  }
                : {}),
        };
    }

    if (lastActive !== undefined) {
        const age = Math.max(0, now - lastActive);
        const level = classifyActivity(age);
        return {
            state: level === "active" ? "online" : level === "recent" ? "unavailable" : "offline",
            source: "activity",
            label: activityLabel(age),
        };
    }
    return null;
}
