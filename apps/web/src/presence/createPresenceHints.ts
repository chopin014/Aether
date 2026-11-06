/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import PlatformPeg from "../PlatformPeg";
import { type CallStore, CallStoreEvent } from "../stores/CallStore";
import { type PresenceHints } from "../viewmodels/presence/PresenceHints";

/** Build presence hints from the app's call store and the platform's view of input across the whole computer. */
export function createPresenceHints(callStore: CallStore): PresenceHints {
    return {
        isInCall: () => callStore.connectedCalls.size > 0,
        watchCalls: (listener) => {
            callStore.on(CallStoreEvent.ConnectedCalls, listener);
            return () => callStore.off(CallStoreEvent.ConnectedCalls, listener);
        },
        getSystemIdleTime: async () => (await PlatformPeg.get()?.getSystemIdleTime()) ?? null,
    };
}
