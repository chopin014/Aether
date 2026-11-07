/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Sort keys for a server's channels and categories. A key is a string of ASCII letters and digits compared character
 * by character, so a new key can always be made between two others without renumbering anything else. Keys never end
 * in the lowest digit, which is what keeps that true.
 */

/** The digits of a key, in the order a plain string comparison puts them. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];

/** Longest key accepted from the server. */
export const MAX_RANK_LENGTH = 2048;

const RANK_PATTERN = /^[0-9A-Za-z]+$/;

/** Whether a value read from the server is a usable key. */
export function isValidRank(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_RANK_LENGTH &&
        RANK_PATTERN.test(value) &&
        !value.endsWith(ZERO)
    );
}

/** Compare two keys, or two strings used as tie breakers, by their characters' codes and never by locale. */
export function compareRanks(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** The key halfway between `a` (or the start) and `b` (or the end). Both are valid keys and `a` sorts before `b`. */
function midpoint(a: string, b: string | null): string {
    if (b !== null) {
        // Keep the prefix the two share, and find a key between what follows it.
        let shared = 0;
        while ((a[shared] ?? ZERO) === b[shared]) shared++;
        if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
    }
    const digitA = a ? DIGITS.indexOf(a[0]) : 0;
    const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
    if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];
    // The first digits are adjacent: `b`'s first digit alone sits between them when `b` goes on after it,
    if (b !== null && b.length > 1) return b.slice(0, 1);
    // otherwise keep `a`'s first digit and look for room after it.
    return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * A key that sorts after `before` and before `after`. Leaving either out means the start or the end of the list.
 * @throws when `before` does not sort before `after`, or the key would grow past {@link MAX_RANK_LENGTH}.
 */
export function rankBetween(before?: string, after?: string): string {
    if (before !== undefined && after !== undefined && compareRanks(before, after) >= 0) {
        throw new Error("rankBetween: keys are equal or out of order");
    }
    const rank = midpoint(before ?? "", after ?? null);
    if (rank.length > MAX_RANK_LENGTH) throw new Error("rankBetween: no room left between these keys");
    return rank;
}

/** Upper-case hexadecimal of a string's UTF-8 bytes; its digits are all key digits. */
function hex(value: string): string {
    return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(
        "",
    );
}

/**
 * A key for a channel nobody has placed yet, derived from its Space child order, when its room was created and its
 * room id, so that every client puts it in the same spot. Channels with a child order come first, in that order; the
 * rest follow in the order they were created, like new channels in Discord, then by room id. None of these change
 * once a channel exists, so an unplaced channel never moves by itself.
 * The "00" after each variable-length part ends it below any of its bytes, so a shorter value sorts before a longer
 * one it starts; the creation time is a fixed-width number.
 * @param childOrder - The valid `order` of the channel's `m.space.child` event, if it has one.
 * @param roomId - The channel's room id.
 * @param createdAt - When the channel's room was created, in milliseconds since the epoch, if known.
 */
export function virtualChannelRank(childOrder: string | undefined, roomId: string, createdAt?: number): string {
    let order: string;
    if (childOrder !== undefined) order = `0${hex(childOrder)}00`;
    else if (createdAt !== undefined && Number.isSafeInteger(createdAt) && createdAt >= 0) {
        order = `1${String(createdAt).padStart(16, "0")}`;
    } else order = "2";
    return `M${order}${hex(roomId)}00V`;
}
