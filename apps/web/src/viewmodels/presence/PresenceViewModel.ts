/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BaseViewModel, type PresencePreference, type PresenceSnapshot } from "@element-hq/web-shared-components";
import { type MatrixClient, MatrixEvent, ClientEvent, SetPresence, UserEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { type MatrixDispatcher } from "../../dispatcher/dispatcher";
import { type ActionPayload } from "../../dispatcher/payloads";
import { Action } from "../../dispatcher/actions";
import { isPresenceEnabled } from "../../utils/presence";
import { getKnownPresence } from "../../utils/knownPresence";
import { presencePreferenceKey, readPresencePreference } from "../../utils/presencePreference";
import { _t } from "../../languageHandler";
import SettingsStore from "../../settings/SettingsStore";
import { type PresenceHints } from "./PresenceHints";

interface Props {
    client: MatrixClient;
    dispatcher: MatrixDispatcher;
}

/** No input for this long makes an Online user Away. */
export const IDLE_MS = 3 * 60 * 1000;

/** While automatically Away, how often to look for input in other apps that should end it. */
export const AWAY_CHECK_MS = 15 * 1000;

/** Own this device's presence intent and automatic idle timer for the lifetime of its Matrix client. */
export class PresenceViewModel extends BaseViewModel<PresenceSnapshot, Props> {
    private timer?: ReturnType<typeof setTimeout>;
    /** Bumped whenever the idle timer is rearmed, so a slow system idle lookup cannot act on old information. */
    private idleCheck = 0;
    private hints?: PresenceHints;
    private started = false;
    private desired: SetPresence;
    private applied?: SetPresence;
    private readonly desiredListeners = new Set<(presence: SetPresence) => void>();
    /** Whether presence is sent to the homeserver. False when the config disables it, e.g. for matrix.org. */
    private readonly serverPresence: boolean;

    public constructor(props: Props) {
        const preference = readPresencePreference(props.client);
        const usable = !props.client.isGuest() && !SettingsStore.getValue("lowBandwidth");
        const serverPresence = usable && isPresenceEnabled(props.client);
        super(props, {
            // The desktop shell also shares the choice with other Aether clients, which works without server presence.
            enabled: serverPresence || (usable && SettingsStore.getValue("feature_desktop_shell")),
            preference,
            desired: preference,
            busy: false,
        });
        this.serverPresence = serverPresence;
        this.desired = preference;
        this.disposables.trackListener(props.client, UserEvent.LastPresenceTs, this.onPresence);
        this.disposables.trackListener(props.client, UserEvent.Presence, this.onPresence);
        this.disposables.trackListener(props.client, ClientEvent.Event, this.onPresenceEvent);
        this.onPresence();
        this.disposables.track(() => {
            clearTimeout(this.timer);
            this.idleCheck++;
        });
        this.disposables.track(() => this.desiredListeners.clear());
    }

    /**
     * Start after the SDK's sync API exists. Repeated calls do not add listeners or requests.
     * @param hints - other signs that the user is present, such as being in a call or using another app
     */
    public start = (hints?: PresenceHints): void => {
        if (this.started || this.isDisposed || !this.snapshot.current.enabled) return;
        this.started = true;
        this.hints = hints;
        const ref = this.props.dispatcher.register(this.onAction);
        this.disposables.track(() => this.props.dispatcher.unregister(ref));
        if (hints) this.disposables.track(hints.watchCalls(this.onCallsChanged));
        this.restartTimer();
        void this.apply(false);
    };

    /** The status this device currently wants to show, including automatic Away while idle. */
    public getDesired = (): SetPresence => this.desired;

    /** Be told whenever {@link getDesired} changes. Returns a function that stops listening. */
    public watchDesired = (listener: (presence: SetPresence) => void): (() => void) => {
        this.desiredListeners.add(listener);
        return () => this.desiredListeners.delete(listener);
    };

    private setDesired = (presence: SetPresence): void => {
        if (presence === this.desired) return;
        this.desired = presence;
        this.snapshot.merge({ desired: presence });
        for (const listener of this.desiredListeners) listener(presence);
    };

    private onPresenceEvent = (event: unknown): void => {
        if (
            event instanceof MatrixEvent &&
            event.getType() === "m.presence" &&
            event.getSender() === this.props.client.getUserId()
        ) {
            this.onPresence();
        }
    };

    private onPresence = (): void => {
        const user = this.props.client.getUser(this.props.client.getSafeUserId());
        const presence = getKnownPresence(user);
        this.snapshot.merge({
            current:
                presence === "online" || presence === "unavailable" || presence === "offline" ? presence : undefined,
        });
    };

    private isAutomatic = (): boolean => this.snapshot.current.preference === "online";

    /** Wait a full idle period from now. No timer runs during a call, since talking is not idling. */
    private restartTimer = (): void => {
        this.scheduleIdleCheck(IDLE_MS);
    };

    private scheduleIdleCheck(delay: number): void {
        clearTimeout(this.timer);
        this.idleCheck++;
        if (!this.isAutomatic() || this.hints?.isInCall()) return;
        this.timer = setTimeout(this.onIdleTimer, delay);
    }

    /** This window has seen no input for a while. */
    private onIdleTimer = (): void => {
        if (this.hints) {
            void this.checkSystemIdle();
        } else {
            this.setDesired(SetPresence.Unavailable);
            void this.apply(false);
        }
    };

    /**
     * Decide between Online and Away using input anywhere on the computer when the platform can report it, so
     * playing a game or working in another app does not look like being away.
     */
    private checkSystemIdle = async (): Promise<void> => {
        const check = this.idleCheck;
        let systemIdle: number | null = null;
        try {
            systemIdle = (await this.hints?.getSystemIdleTime()) ?? null;
        } catch (error) {
            logger.debug("Could not read system idle time", error);
        }
        // Activity, a call or a new preference while waiting has already decided.
        if (this.isDisposed || check !== this.idleCheck || !this.isAutomatic() || this.hints?.isInCall()) return;

        if (systemIdle === null) {
            // Only this window's input is known, and the timer only fires after a full idle period of it.
            this.setDesired(SetPresence.Unavailable);
            void this.apply(false);
            return;
        }
        if (systemIdle < IDLE_MS) {
            this.setDesired(SetPresence.Online);
            this.scheduleIdleCheck(IDLE_MS - systemIdle);
        } else {
            this.setDesired(SetPresence.Unavailable);
            // Keep looking so that coming back to another app, without touching this window, ends Away.
            this.scheduleIdleCheck(AWAY_CHECK_MS);
        }
        void this.apply(false);
    };

    /** Being connected to a call keeps an automatic status Online; leaving starts a fresh idle period. */
    private onCallsChanged = (): void => {
        if (!this.isAutomatic()) return;
        if (this.hints?.isInCall()) this.setDesired(SetPresence.Online);
        this.restartTimer();
        void this.apply(false);
    };

    private onAction = (payload: ActionPayload): void => {
        if (payload.action !== Action.UserActivity || !this.isAutomatic()) return;
        this.setDesired(SetPresence.Online);
        this.restartTimer();
        void this.apply(false);
    };

    /** Persist intent immediately, including invisible intent when offline, and attempt one real server request. */
    public setPreference = async (preference: PresencePreference): Promise<void> => {
        if (!this.snapshot.current.enabled || this.snapshot.current.busy || this.isDisposed) return;
        this.setDesired(preference as SetPresence);
        this.snapshot.merge({ preference, error: undefined });
        this.restartTimer();
        try {
            localStorage.setItem(presencePreferenceKey(this.props.client), preference);
        } catch {
            this.snapshot.merge({ error: _t("presence|save_failed") });
            return;
        }
        await this.apply(true);
    };

    /** Retry only on an explicit user action, preventing activity events from flooding a failing server. */
    public retry = async (): Promise<void> => {
        await this.setPreference(this.snapshot.current.preference);
    };

    private apply = async (manual: boolean): Promise<void> => {
        if (this.isDisposed || !this.snapshot.current.enabled || this.snapshot.current.busy) return;
        if (!manual && (this.snapshot.current.error || this.desired === this.applied)) return;
        const desired = this.desired;
        if (!this.serverPresence) {
            this.applied = desired;
            return;
        }
        this.snapshot.merge({ busy: true });
        try {
            // Sync must retain the same intent, so subsequent activity cannot undo Away or Invisible.
            await this.props.client.setSyncPresence(desired);
            if (this.isDisposed) return;
            if (manual || desired !== SetPresence.Online) {
                const status = this.props.client.getUser(this.props.client.getSafeUserId())?.presenceStatusMsg;
                await this.props.client.setPresence({ presence: desired, ...(status ? { status_msg: status } : {}) });
            }
            if (!this.isDisposed) this.applied = desired;
        } catch (error) {
            logger.warn("Unable to update presence", error);
            if (!this.isDisposed) this.snapshot.merge({ error: _t("presence|update_failed") });
        } finally {
            if (!this.isDisposed) {
                this.snapshot.merge({ busy: false });
                // Activity may have changed automatic presence while the preceding request was in flight.
                if (this.desired !== desired && !this.snapshot.current.error) void this.apply(false);
            }
        }
    };
}
