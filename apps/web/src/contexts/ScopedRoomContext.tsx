/*
Copyright 2024 New Vector Ltd.
Copyright 2019 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, {
    type JSX,
    type ContextType,
    memo,
    type ReactNode,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
} from "react";

import RoomContext from "./RoomContext.ts";
import { ScopedRoomContext, ScopedRoomContextStore } from "./scoped-room-context-store.ts";

// React Contexts with frequently changing values (like State where the object reference is changed on every update)
// cause performance issues by triggering a re-render on every component subscribed to that context.
// With ScopedRoomContext we're effectively setting up virtual contexts which are a subset of the overall context object
// and subscribers specify which fields they care about, and they will only be awoken on updates to those specific fields.

type ContextValue = ContextType<typeof RoomContext>;

// Uses react memo and leverages splatting the value to ensure that the context is only updated when the state changes (shallow compare)
export const ScopedRoomContextProvider = memo(
    ({ children, ...state }: { children: ReactNode } & ContextValue): JSX.Element => {
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const store = useMemo(() => new ScopedRoomContextStore(state), []);
        const revision = useRef(0);
        // Published once committed, after the components under it, which read the store as they render.
        useEffect(() => {
            store.publish(state, ++revision.current);
        }, [store, state]);

        // Includes the legacy RoomContext provider for backwards compatibility with class components
        return (
            <RoomContext.Provider value={state}>
                <ScopedRoomContext.Provider value={store}>{children}</ScopedRoomContext.Provider>
            </RoomContext.Provider>
        );
    },
);

type ScopedRoomContextFields<K extends Array<keyof ContextValue>> = Pick<ContextValue, K[number]>;

/** What a component reads without a scoped room context provider above it: nothing. */
const NO_CONTEXT = Object.freeze({});

// Joins a list of keys into one string, so the list can be compared by its value rather than its identity.
const KEY_SEPARATOR = "\u0000";

/**
 * A subscription to the fields `keyList` names, for `useSyncExternalStore`. It hands out the same object while none of
 * those fields changes, so a change to any other field neither re-renders the component nor gives it a new object.
 */
function selectionOf(
    store: ScopedRoomContextStore | undefined,
    keyList: string,
): { subscribe: (onChange: () => void) => () => void; getSnapshot: () => object } {
    if (!store) return { subscribe: () => () => {}, getSnapshot: () => NO_CONTEXT };
    const keys = keyList.split(KEY_SEPARATOR) as Array<keyof ContextValue>;
    let selectedFrom: ContextValue | undefined;
    let selected: object = NO_CONTEXT;
    return {
        subscribe: store.subscribe,
        getSnapshot: (): object => {
            const value = store.getSnapshot().value;
            if (value === selectedFrom) return selected;
            const from = selectedFrom;
            selectedFrom = value;
            if (from === undefined || keys.some((key) => !Object.is(from[key], value[key]))) {
                selected = Object.fromEntries(keys.map((key) => [key, value[key]]));
            }
            return selected;
        },
    };
}

/**
 * The fields `keys` of the room context the nearest scoped room context provider gives, re-rendering only when one of
 * them changes. Without a provider, an empty object.
 */
export function useScopedRoomContext<K extends Array<keyof ContextValue>>(...keys: K): ScopedRoomContextFields<K> {
    const store = useContext(ScopedRoomContext);
    const keyList = keys.join(KEY_SEPARATOR);
    const selection = useMemo(() => selectionOf(store, keyList), [store, keyList]);
    // Rendering to static markup, as a chat export does, reads the store as it is: it holds the provider's value.
    return useSyncExternalStore(
        selection.subscribe,
        selection.getSnapshot,
        selection.getSnapshot,
    ) as ScopedRoomContextFields<K>;
}
