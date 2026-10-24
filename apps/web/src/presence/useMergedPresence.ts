/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect, useReducer } from "react";
import { ClientEvent, type MatrixClient, type MatrixEvent, type User, UserEvent } from "matrix-js-sdk/src/matrix";

import Presence from "../Presence";
import { getLocalPresence } from "./localPresence";
import { useMatrixClientContext } from "../contexts/MatrixClientContext";
import { useEventEmitter } from "../hooks/useEventEmitter";
import { useFeatureEnabled } from "../hooks/useSettings";
import { BUSY_PRESENCE_NAME } from "../components/views/rooms/PresenceLabel";
import { getKnownPresence } from "../utils/knownPresence";
import { isPresenceEnabled } from "../utils/presence";
import { AetherPresenceService } from "./AetherPresenceService";
import { AetherPresenceStoreEvent } from "./AetherPresenceStore";
import { ActivityTrackerEvent } from "./ActivityTracker";
import { msUntilLevelChange } from "./activityHint";
import { mergePresence, type MergedPresence, type MergedPresenceState } from "./mergedPresence";

/** The homeserver's presence for a user, if the homeserver is configured to provide it and has sent some. */
export function getServerPresence(client: MatrixClient, userId: string): MergedPresenceState | undefined {
    if (!isPresenceEnabled(client)) return undefined;
    const presence = getKnownPresence(client.getUser(userId));
    if (!presence) return undefined;
    if (BUSY_PRESENCE_NAME.matches(presence)) return "busy";
    if (presence === "online" || presence === "unavailable" || presence === "offline") return presence;
    return undefined;
}

/** The best current status for a user right now, or null if nothing is known. */
export function getMergedPresence(client: MatrixClient, userId: string, now = Date.now()): MergedPresence | null {
    const local = getLocalPresence(client, userId);
    if (local) return local;
    const service = AetherPresenceService.instance;
    return mergePresence({
        server: getServerPresence(client, userId),
        aether: service.store?.getSignal(userId),
        lastActive: service.activity?.getLastActive(userId),
        now,
    });
}

/**
 * The status to show for a user, merging server presence, Aether signals and seen activity, and re-rendering when
 * any of them change or when the passage of time changes the answer. Returns null when the desktop shell is off,
 * so callers keep their existing behaviour.
 */
export function useMergedPresence(userId: string | undefined): MergedPresence | null {
    const client = useMatrixClientContext();
    const enabled = useFeatureEnabled("feature_desktop_shell");
    const [, refresh] = useReducer((n: number) => n + 1, 0);
    const service = AetherPresenceService.instance;
    const watch = enabled ? userId : undefined;
    const onUser = (id: string): void => {
        if (id === watch) refresh();
    };

    useEventEmitter(watch ? service.store : undefined, AetherPresenceStoreEvent.Update, onUser);
    useEventEmitter(watch ? service.activity : undefined, ActivityTrackerEvent.Update, onUser);
    useEventEmitter(watch ? client : undefined, UserEvent.Presence, (_: unknown, user: User) => onUser(user?.userId));
    useEventEmitter(watch ? client : undefined, UserEvent.LastPresenceTs, (_: unknown, user: User) =>
        onUser(user?.userId),
    );
    useEventEmitter(watch ? client : undefined, ClientEvent.Event, (event: MatrixEvent) => {
        if (event.getType() === "m.presence") onUser(event.getSender() ?? "");
    });

    useEffect(() => {
        if (!watch || watch !== client.getUserId()) return;
        const unwatch = Presence.forClient(client).watchDesired(refresh);
        refresh();
        return unwatch;
    }, [client, watch]);

    const merged = watch ? getMergedPresence(client, watch) : null;
    const lastActive = watch ? service.activity?.getLastActive(watch) : undefined;
    const source = merged?.source;

    // Activity ages from green to amber to grey by itself, so come back when it is due.
    useEffect(() => {
        if (source !== "activity" || lastActive === undefined) return;
        const wait = msUntilLevelChange(Date.now() - lastActive);
        if (wait === undefined) return;
        const timer = setTimeout(refresh, wait + 50);
        return () => clearTimeout(timer);
    }, [source, lastActive, merged?.state]);

    return merged;
}
