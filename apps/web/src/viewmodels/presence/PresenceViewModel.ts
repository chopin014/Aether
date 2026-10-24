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

interface Props {
    client: MatrixClient;
    dispatcher: MatrixDispatcher;
}

const IDLE_MS = 3 * 60 * 1000;

/** Own this device's presence intent and automatic idle timer for the lifetime of its Matrix client. */
export class PresenceViewModel extends BaseViewModel<PresenceSnapshot, Props> {
    private timer?: ReturnType<typeof setTimeout>;
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
        this.disposables.track(() => clearTimeout(this.timer));
        this.disposables.track(() => this.desiredListeners.clear());
    }

    /** Start after the SDK's sync API exists. Repeated calls do not add listeners or requests. */
    public start = (): void => {
        if (this.started || this.isDisposed || !this.snapshot.current.enabled) return;
        this.started = true;
        const ref = this.props.dispatcher.register(this.onAction);
        this.disposables.track(() => this.props.dispatcher.unregister(ref));
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

    private restartTimer = (): void => {
        clearTimeout(this.timer);
        if (this.snapshot.current.preference !== "online") return;
        this.timer = setTimeout(() => {
            this.setDesired(SetPresence.Unavailable);
            void this.apply(false);
        }, IDLE_MS);
    };

    private onAction = (payload: ActionPayload): void => {
        if (payload.action !== Action.UserActivity || this.snapshot.current.preference !== "online") return;
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
