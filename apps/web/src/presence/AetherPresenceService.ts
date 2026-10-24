/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import Presence from "../Presence";
import SettingsStore from "../settings/SettingsStore";
import { AetherPresenceBroadcaster } from "./AetherPresenceBroadcaster";
import { AetherPresenceStore } from "./AetherPresenceStore";
import { ActivityTracker } from "./ActivityTracker";

/**
 * Owns the Aether presence broadcaster and receiver for the lifetime of one Matrix client.
 * Nothing is created unless the desktop shell is enabled, so the flag-off client behaves exactly as upstream.
 */
export class AetherPresenceService {
    private static internalInstance?: AetherPresenceService;

    /** The shared service. */
    public static get instance(): AetherPresenceService {
        return (AetherPresenceService.internalInstance ??= new AetherPresenceService());
    }

    private client?: MatrixClient;
    private broadcaster?: AetherPresenceBroadcaster;
    private unwatch?: () => void;
    private internalStore?: AetherPresenceStore;
    private internalTracker?: ActivityTracker;

    /** What we have seen other users do, or undefined while the service is not running. */
    public get activity(): ActivityTracker | undefined {
        return this.internalTracker;
    }

    /** Signals received from other Aether clients, or undefined while the service is not running. */
    public get store(): AetherPresenceStore | undefined {
        return this.internalStore;
    }

    /** Begin once the client's sync has started and crypto is ready. Safe to call again for the same client. */
    public start(client: MatrixClient): void {
        if (this.client === client) return;
        this.stop();
        if (!SettingsStore.getValue("feature_desktop_shell") || client.isGuest()) return;
        if (SettingsStore.getValue("lowBandwidth")) return;
        this.client = client;

        this.internalStore = new AetherPresenceStore(client);
        this.internalStore.start();
        this.internalTracker = new ActivityTracker(client);
        this.internalTracker.start();

        const presence = Presence.forClient(client);
        this.broadcaster = new AetherPresenceBroadcaster(client);
        this.unwatch = presence.watchDesired((desired) => this.broadcaster?.setPresence(desired));
        this.broadcaster.start(presence.getDesired());
        // Quitting or reloading the app: tell people we left without waiting for the heartbeat to lapse.
        window.addEventListener("pagehide", this.onPageHide);
    }

    private onPageHide = (): void => this.stop();

    /** Stop all timers and listeners, sending a best-effort `offline` first. */
    public stop(): void {
        window.removeEventListener("pagehide", this.onPageHide);
        this.unwatch?.();
        this.unwatch = undefined;
        this.broadcaster?.stop();
        this.broadcaster = undefined;
        this.internalStore?.stop();
        this.internalStore = undefined;
        this.internalTracker?.stop();
        this.internalTracker = undefined;
        this.client = undefined;
    }
}
