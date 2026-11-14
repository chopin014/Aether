/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createContext } from "react";
import { logger } from "matrix-js-sdk/src/logger";

import type { RoomContextType } from "./RoomContext";

/** What a {@link ScopedRoomContextStore} holds at one time: a room context value and its revision. */
export interface ScopedRoomSnapshot {
    /** Grows with every value published; the first value is revision 0. */
    readonly revision: number;
    readonly value: RoomContextType;
}

/**
 * The room context the components under a scoped room context provider read, which they subscribe to so that each
 * hears only of changes to the fields it reads. It holds the value and who listens, and nothing else: it watches no
 * room or client of its own.
 */
export class ScopedRoomContextStore {
    private snapshot: ScopedRoomSnapshot;
    private readonly listeners = new Set<() => void>();

    public constructor(initial: RoomContextType) {
        this.snapshot = { revision: 0, value: initial };
    }

    /** The current value and its revision; the same object until a new value is published. */
    public getSnapshot = (): ScopedRoomSnapshot => this.snapshot;

    /** Call `listener` after each value published, until the returned function is called. */
    public subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    /**
     * Make `value` the current value at `revision`, and tell every listener. A revision older than the current one is
     * ignored, as is the current revision again: a publication can arrive late, or twice, without going back.
     */
    public publish = (value: RoomContextType, revision: number): void => {
        const current = this.snapshot;
        if (revision < current.revision) return;
        if (revision === current.revision) {
            if (value !== current.value) {
                logger.warn(`ScopedRoomContextStore: revision ${revision} was published again with another value`);
            }
            return;
        }
        this.snapshot = { revision, value };
        for (const listener of this.listeners) listener();
    };
}

/** The store of the nearest scoped room context provider, if there is one. */
export const ScopedRoomContext = createContext<ScopedRoomContextStore | undefined>(undefined);
