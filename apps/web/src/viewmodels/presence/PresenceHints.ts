/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Signs that the user is still at the computer even when they are not typing or moving the mouse in this window.
 * Used to decide when automatic Away should start and end.
 */
export interface PresenceHints {
    /** Whether this device is connected to a call right now. Someone talking in a call is not away. */
    isInCall(): boolean;
    /** Be told when {@link isInCall} may have changed. Returns a function that stops listening. */
    watchCalls(listener: () => void): () => void;
    /**
     * Milliseconds since the last keyboard or mouse input anywhere on the computer, including other apps,
     * or null when the platform cannot tell.
     */
    getSystemIdleTime(): Promise<number | null>;
}
