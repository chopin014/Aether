/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";

import { CallEvent, ElementCall, type Call } from "./Call";
import SettingsStore from "../settings/SettingsStore";
import { forceMicrophoneChange, getServerVoiceMute, onServerVoiceMutesChanged } from "../utils/call/serverVoiceMute";

const logger = rootLogger.getChild("ServerVoiceMuteEnforcer");

/**
 * Keeps this user's microphone off in the voice channels of a server where a moderator muted them, and their call
 * silent where a moderator deafened them, as Discord's server mute and server deafen do. Whatever turns the microphone
 * back on (the dock, the call's own controls, push to talk) is undone at once.
 *
 * When a moderator lifts the mute or the deafen, the user is back as they were, as in Discord: the microphone comes
 * back on if this enforcer turned it off and the user has not muted or deafened themselves, and the call plays again
 * unless the user deafened themselves.
 */
export class ServerVoiceMuteEnforcer {
    private disposed = false;
    /** The calls watched, with the function that stops watching each. */
    private readonly watched = new Map<ElementCall, () => void>();
    /** The calls this enforcer silenced, which it plays again once the deafen is lifted. */
    private readonly silenced = new Set<ElementCall>();
    /** The calls in which this enforcer turned the microphone off, which it turns on again once the mute is lifted. */
    private readonly microphoneTurnedOff = new Set<ElementCall>();
    private readonly stopListening: () => void;

    /** @param getCalls - The calls this device is in or joining. */
    public constructor(
        private readonly client: MatrixClient,
        private readonly getCalls: () => Iterable<Call>,
    ) {
        this.stopListening = onServerVoiceMutesChanged(client, this.update);
        this.update();
    }

    public dispose(): void {
        this.disposed = true;
        this.stopListening();
        for (const stop of this.watched.values()) stop();
        this.watched.clear();
        this.silenced.clear();
        this.microphoneTurnedOff.clear();
    }

    /** Watches the calls this device is in now and applies every moderator's mute to them. */
    public readonly update = (): void => {
        if (this.disposed) return;
        const calls = new Set([...this.getCalls()].filter((call): call is ElementCall => call instanceof ElementCall));
        for (const [call, stop] of this.watched) {
            if (calls.has(call)) continue;
            stop();
            this.watched.delete(call);
            this.silenced.delete(call);
            this.microphoneTurnedOff.delete(call);
        }
        for (const call of calls) {
            if (!this.watched.has(call)) {
                const enforce = (): void => this.enforce(call);
                call.on(CallEvent.DeviceMute, enforce);
                call.on(CallEvent.ConnectionState, enforce);
                this.watched.set(call, () => {
                    call.off(CallEvent.DeviceMute, enforce);
                    call.off(CallEvent.ConnectionState, enforce);
                });
            }
            this.enforce(call);
        }
    };

    private enforce(call: ElementCall): void {
        if (this.disposed || !call.connected) return;
        const { muted, deafened } = getServerVoiceMute(this.client, call.roomId, this.client.getSafeUserId());
        if (muted) {
            if (call.deviceMuteState?.audio_enabled !== false) {
                this.microphoneTurnedOff.add(call);
                forceMicrophoneChange(call, call.setDeviceMute({ audio_enabled: false })).catch((error) =>
                    logger.warn(`Could not keep the microphone off in ${call.roomId}`, error),
                );
            }
        } else if (this.microphoneTurnedOff.delete(call) && !this.mutedThemselves()) {
            // Asked even when the call reports the microphone on: turning it off may still be under way.
            forceMicrophoneChange(call, call.setDeviceMute({ audio_enabled: true })).catch((error) =>
                logger.warn(`Could not turn the microphone back on in ${call.roomId}`, error),
            );
        }
        try {
            if (deafened && !this.silenced.has(call)) {
                call.setAudioOutputEnabled(false);
                this.silenced.add(call);
            } else if (!deafened && this.silenced.has(call)) {
                call.setAudioOutputEnabled(!SettingsStore.getValue("desktopDeafened"));
                this.silenced.delete(call);
            }
        } catch (error) {
            logger.warn(`Could not change playback in ${call.roomId}`, error);
        }
    }

    /** Whether the user muted or deafened themselves, which the dock keeps whatever a moderator does. */
    private mutedThemselves(): boolean {
        return SettingsStore.getValue("audioInputMuted") || SettingsStore.getValue("desktopDeafened");
    }
}
