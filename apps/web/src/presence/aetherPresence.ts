/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Custom to-device event type exchanged between Aether clients. This is not part of the Matrix specification. */
export const AETHER_PRESENCE_EVENT_TYPE = "io.aether.presence";

/** Wire format version of {@link AetherPresenceContent}. */
export const AETHER_PRESENCE_VERSION = 1;

/** How often a running client repeats its status, so that receivers can tell it is still there. */
export const HEARTBEAT_MS = 4.5 * 60 * 1000;

/** How long a receiver trusts a signal. This covers two missed heartbeats plus clock and network slack. */
export const PRESENCE_TTL_MS = 12 * 60 * 1000;

/** Rooms with more joined members than this are never used to pick recipients. */
export const MAX_ROOM_MEMBERS = 50;

/** Upper bound on recipients per heartbeat, so a client in many small rooms cannot flood the homeserver. */
export const MAX_RECIPIENTS = 200;

/** Statuses an Aether client can announce. `offline` is also what Invisible sends before it goes quiet. */
export type AetherPresenceState = "online" | "unavailable" | "busy" | "offline";

/** Content of an {@link AETHER_PRESENCE_EVENT_TYPE} to-device event. */
export interface AetherPresenceContent {
    v: typeof AETHER_PRESENCE_VERSION;
    presence: AetherPresenceState;
    /** Milliseconds since the sender was last active, when known. */
    last_active_ago?: number;
    /** How long, from `ts`, the receiver should believe this signal. */
    ttl_ms: number;
    /** Sender's clock when the event was created, in milliseconds since the epoch. */
    ts: number;
}

const STATES: readonly string[] = ["online", "unavailable", "busy", "offline"];

/** Build the content for the given status. */
export function buildAetherPresence(
    presence: AetherPresenceState,
    now: number,
    lastActiveAgo?: number,
): AetherPresenceContent {
    return {
        v: AETHER_PRESENCE_VERSION,
        presence,
        ...(lastActiveAgo !== undefined && lastActiveAgo >= 0 ? { last_active_ago: Math.round(lastActiveAgo) } : {}),
        ttl_ms: PRESENCE_TTL_MS,
        ts: now,
    };
}

/**
 * Validate untrusted event content. Returns undefined for anything malformed, from an unknown version, or with a
 * non-positive lifetime. The lifetime is clamped to {@link PRESENCE_TTL_MS} so a sender cannot pin a status forever.
 */
export function parseAetherPresence(content: unknown): AetherPresenceContent | undefined {
    if (!content || typeof content !== "object") return undefined;
    const c = content as Record<string, unknown>;
    if (c.v !== AETHER_PRESENCE_VERSION) return undefined;
    if (typeof c.presence !== "string" || !STATES.includes(c.presence)) return undefined;
    if (typeof c.ts !== "number" || !Number.isFinite(c.ts)) return undefined;
    if (typeof c.ttl_ms !== "number" || !Number.isFinite(c.ttl_ms) || c.ttl_ms <= 0) return undefined;
    const lastActiveAgo =
        typeof c.last_active_ago === "number" && Number.isFinite(c.last_active_ago) && c.last_active_ago >= 0
            ? c.last_active_ago
            : undefined;
    return {
        v: AETHER_PRESENCE_VERSION,
        presence: c.presence as AetherPresenceState,
        ...(lastActiveAgo !== undefined ? { last_active_ago: lastActiveAgo } : {}),
        ttl_ms: Math.min(c.ttl_ms, PRESENCE_TTL_MS),
        ts: c.ts,
    };
}
