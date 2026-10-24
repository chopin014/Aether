/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    type MatrixClient,
    type ReceivedToDeviceMessage,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";

import { AETHER_PRESENCE_EVENT_TYPE, parseAetherPresence, type AetherPresenceState } from "./aetherPresence";
import { sharesJoinedRoom } from "./AetherPresenceRecipients";

export enum AetherPresenceStoreEvent {
    /** A user's signal appeared, changed or expired. The payload is the user ID. */
    Update = "update",
}

type EmittedEvents = AetherPresenceStoreEvent;
type EventHandlerMap = { [AetherPresenceStoreEvent.Update]: (userId: string) => void };

/** The latest status another Aether client announced about itself. */
export interface AetherPresenceSignal {
    /** Reported status, or `offline` once the signal has expired. */
    presence: AetherPresenceState;
    /** When the sender created the report, in milliseconds since the epoch. */
    lastSeen: number;
    /** Whether the report was not renewed within its lifetime, so `offline` is an assumption. */
    expired: boolean;
}

interface Entry {
    presence: AetherPresenceState;
    /** Sender's timestamp, used to discard reordered messages. */
    sentAt: number;
    /** Local time of arrival. Expiry is measured on our own clock so sender clock skew cannot extend it. */
    receivedAt: number;
    ttl: number;
    /** Whether listeners were told that this entry ran out. */
    expiryAnnounced: boolean;
}

/**
 * Receives `io.aether.presence` to-device messages and remembers each sender's latest status until it expires.
 *
 * Only messages that arrived Olm-encrypted are used, because that is what proves who sent them. Signals from
 * ignored users, from people we share no joined room with, with bad content, or older than their own lifetime
 * are dropped.
 */
export class AetherPresenceStore extends TypedEventEmitter<EmittedEvents, EventHandlerMap> {
    private readonly entries = new Map<string, Entry>();
    private timer?: ReturnType<typeof setTimeout>;
    private started = false;

    public constructor(
        private readonly client: MatrixClient,
        private readonly now: () => number = Date.now,
    ) {
        super();
    }

    public start(): void {
        if (this.started) return;
        this.started = true;
        this.client.on(ClientEvent.ReceivedToDeviceMessage, this.onMessage);
    }

    public stop(): void {
        this.started = false;
        this.client.off(ClientEvent.ReceivedToDeviceMessage, this.onMessage);
        clearTimeout(this.timer);
        this.entries.clear();
    }

    /** The latest signal for this user, or undefined if none was ever accepted. */
    public getSignal(userId: string): AetherPresenceSignal | undefined {
        const entry = this.entries.get(userId);
        if (!entry) return undefined;
        const expired = this.isExpired(entry);
        return { presence: expired ? "offline" : entry.presence, lastSeen: entry.sentAt, expired };
    }

    private isExpired(entry: Entry): boolean {
        return entry.presence !== "offline" && this.now() >= entry.receivedAt + entry.ttl;
    }

    private onMessage = ({ message, encryptionInfo }: ReceivedToDeviceMessage): void => {
        if (message.type !== AETHER_PRESENCE_EVENT_TYPE) return;
        // Plaintext to-device events carry no proof of origin beyond the server's word.
        if (!encryptionInfo || encryptionInfo.sender !== message.sender) return;
        const sender = encryptionInfo.sender;
        if (sender === this.client.getUserId()) return;
        if (this.client.getIgnoredUsers().includes(sender)) return;
        const content = parseAetherPresence(message.content);
        if (!content) return;
        const now = this.now();
        if (now - content.ts > content.ttl_ms) return;
        const previous = this.entries.get(sender);
        if (previous && previous.sentAt >= content.ts) return;
        if (!sharesJoinedRoom(this.client, sender)) return;

        this.entries.set(sender, {
            presence: content.presence,
            sentAt: content.ts,
            receivedAt: now,
            ttl: content.ttl_ms,
            expiryAnnounced: false,
        });
        this.emit(AetherPresenceStoreEvent.Update, sender);
        this.scheduleExpiry();
    };

    /** One timer for the soonest expiry, so each signal does not need its own. */
    private scheduleExpiry(): void {
        clearTimeout(this.timer);
        const now = this.now();
        let next = Infinity;
        for (const entry of this.entries.values()) {
            if (entry.presence === "offline") continue;
            const at = entry.receivedAt + entry.ttl;
            if (at > now) next = Math.min(next, at);
        }
        if (next === Infinity) return;
        this.timer = setTimeout(
            () => {
                for (const [userId, entry] of this.entries) {
                    if (!entry.expiryAnnounced && this.isExpired(entry)) {
                        entry.expiryAnnounced = true;
                        this.emit(AetherPresenceStoreEvent.Update, userId);
                    }
                }
                this.scheduleExpiry();
            },
            next - now + 1,
        );
    }
}
