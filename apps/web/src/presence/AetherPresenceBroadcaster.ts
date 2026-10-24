/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, SetPresence } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import {
    AETHER_PRESENCE_EVENT_TYPE,
    HEARTBEAT_MS,
    buildAetherPresence,
    type AetherPresenceState,
} from "./aetherPresence";
import { selectPresenceRecipients } from "./AetherPresenceRecipients";

const MIN_BACKOFF_MS = 30 * 1000;

/** First wait before looking again when there is nobody to tell yet, e.g. while rooms are still loading. */
const NO_RECIPIENTS_RETRY_MS = 10 * 1000;

function toWireState(presence: SetPresence): AetherPresenceState {
    switch (presence) {
        case SetPresence.Unavailable:
            return "unavailable";
        case SetPresence.Offline:
            return "offline";
        default:
            return "online";
    }
}

/**
 * Announces this account's chosen status to the people it shares a DM or a small room with, using one batched,
 * Olm-encrypted to-device send per heartbeat.
 *
 * Without end-to-end crypto nothing is sent: a plaintext signal would be unauthenticated for the receiver and would
 * reveal when the account is active to the homeserver operator.
 *
 * While the status is Invisible a single `offline` is sent and then the broadcaster stays quiet.
 */
export class AetherPresenceBroadcaster {
    private presence: SetPresence = SetPresence.Online;
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
    private sending = false;
    private resend = false;
    private failures = 0;
    private emptyChecks = 0;
    private lastSent?: AetherPresenceState;

    public constructor(private readonly client: MatrixClient) {}

    /** Send the current status straight away and keep repeating it while the app runs. */
    public start(presence: SetPresence): void {
        if (this.running) return;
        this.running = true;
        this.presence = presence;
        this.trigger();
    }

    /** Called when the chosen status changes. Sends immediately instead of waiting for the next heartbeat. */
    public setPresence(presence: SetPresence): void {
        if (!this.running || presence === this.presence) return;
        this.presence = presence;
        this.failures = 0;
        this.emptyChecks = 0;
        this.trigger();
    }

    /** Stop the timers. A best-effort `offline` goes out first unless one was already the last thing sent. */
    public stop(): void {
        if (!this.running) return;
        this.running = false;
        clearTimeout(this.timer);
        if (this.lastSent !== undefined && this.lastSent !== "offline") {
            void this.sendOnce("offline").catch((e) => logger.debug("Could not send final Aether presence", e));
        }
    }

    private trigger(): void {
        clearTimeout(this.timer);
        if (this.sending) {
            this.resend = true;
            return;
        }
        void this.tick();
    }

    private tick = async (): Promise<void> => {
        if (!this.running) return;
        const state = toWireState(this.presence);
        // Invisible: tell everyone once, then stay silent until the choice changes.
        const quiet = state === "offline" && this.lastSent === "offline";
        let delay = HEARTBEAT_MS;
        if (!quiet) {
            this.sending = true;
            try {
                const reached = await this.sendOnce(state);
                this.failures = 0;
                if (reached) {
                    this.emptyChecks = 0;
                } else {
                    // The first sync can finish before rooms and DMs are known, so look again soon, then less often.
                    delay = Math.min(HEARTBEAT_MS, NO_RECIPIENTS_RETRY_MS * 2 ** this.emptyChecks++);
                }
            } catch (e) {
                this.failures++;
                const retryAfter = (e as { data?: { retry_after_ms?: number } }).data?.retry_after_ms;
                delay = Math.min(
                    HEARTBEAT_MS,
                    Math.max(
                        MIN_BACKOFF_MS * 2 ** (this.failures - 1),
                        typeof retryAfter === "number" ? retryAfter : 0,
                    ),
                );
                logger.warn(`Aether presence send failed (attempt ${this.failures}), retrying in ${delay}ms`, e);
            } finally {
                this.sending = false;
            }
        }
        if (!this.running) return;
        if (this.resend) {
            this.resend = false;
            void this.tick();
            return;
        }
        if (state === "offline" && this.lastSent === "offline") return;
        this.timer = setTimeout(() => void this.tick(), delay);
    };

    /** Returns false when there was nobody to send to. */
    private async sendOnce(state: AetherPresenceState): Promise<boolean> {
        const crypto = this.client.getCrypto();
        if (!crypto) return true;
        const recipients = selectPresenceRecipients(this.client);
        if (!recipients.length) return false;
        const deviceMap = await crypto.getUserDeviceInfo(recipients, true);
        const devices: { userId: string; deviceId: string }[] = [];
        for (const [userId, userDevices] of deviceMap) {
            for (const [deviceId, device] of userDevices) {
                if (!device.dehydrated) devices.push({ userId, deviceId });
            }
        }
        if (devices.length) {
            const batch = await crypto.encryptToDeviceMessages(
                AETHER_PRESENCE_EVENT_TYPE,
                devices,
                buildAetherPresence(state, Date.now()),
            );
            // Nothing could be encrypted yet, e.g. the recipients' keys are still being fetched.
            if (!batch.batch.length) return false;
            // The SDK queue splits large batches and retries with its own back-off, including after 429.
            await this.client.queueToDevice(batch);
        }
        this.lastSent = state;
        return true;
    }
}
