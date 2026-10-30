/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ClientEvent, MatrixError, type MatrixClient, type ReceivedToDeviceMessage } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { LruCache } from "../utils/LruCache";
import { selectPresenceRecipients, sharesJoinedRoom } from "../presence/AetherPresenceRecipients";
import { EMPTY_RICH_PROFILE, parseRichProfile, type RichProfile } from "./richProfile";

/** To-device hint that someone just saved their profile, since profile fields are not pushed by most servers. */
export const PROFILE_UPDATED_EVENT_TYPE = "io.aether.profile.updated";

const CACHE_SIZE = 1000;
/** A profile younger than this is served without asking the server again. */
const FRESH_MS = 10 * 60 * 1000;
/** A surface opened on purpose, like a profile card, tolerates only this much staleness. */
const FRESH_ON_OPEN_MS = 30 * 1000;
/** Failures (usually a remote server refusing or timing out) are not retried for this long. */
const FAILED_MS = 30 * 60 * 1000;
/** A full member list must not turn into hundreds of simultaneous federation lookups. */
const MAX_CONCURRENT = 4;
/** One person's client cannot make us refetch their profile more often than this. */
const HINT_INTERVAL_MS = 30 * 1000;

interface Entry {
    raw: Record<string, unknown>;
    profile: RichProfile;
    fetchedAt: number;
    failed: boolean;
}

/**
 * Cached, deduplicated access to the rich profiles of other people. Member lists and timelines read through this, so
 * however many rows show a person they cause one request, and a slow remote server never blocks a render.
 */
export class RichProfileStore {
    private static readonly stores = new WeakMap<MatrixClient, RichProfileStore>();

    /** The store for this client. */
    public static forClient(client: MatrixClient): RichProfileStore {
        let store = RichProfileStore.stores.get(client);
        if (!store) {
            store = new RichProfileStore(client);
            RichProfileStore.stores.set(client, store);
        }
        return store;
    }

    private readonly entries = new LruCache<string, Entry>(CACHE_SIZE);
    private readonly listeners = new Map<string, Set<() => void>>();
    private readonly inFlight = new Map<string, Promise<void>>();
    private readonly queue: (() => void)[] = [];
    private readonly lastHint = new Map<string, number>();
    private active = 0;
    private supported?: Promise<boolean>;

    public constructor(
        private readonly client: MatrixClient,
        private readonly now: () => number = Date.now,
    ) {
        client.on(ClientEvent.UserProfileUpdate, this.onSyncUpdate);
        client.on(ClientEvent.ReceivedToDeviceMessage, this.onToDevice);
    }

    /** The profile known so far, without asking the server. */
    public get(userId: string): RichProfile | undefined {
        return this.entries.get(userId)?.profile;
    }

    /** The unparsed fields known so far, for working out what a save has to change. */
    public getRaw(userId: string): Record<string, unknown> | undefined {
        return this.entries.get(userId)?.raw;
    }

    /** Be told when this person's profile changes. */
    public subscribe(userId: string, listener: () => void): () => void {
        let set = this.listeners.get(userId);
        if (!set) {
            set = new Set();
            this.listeners.set(userId, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (!set.size) this.listeners.delete(userId);
        };
    }

    /**
     * Fetch the profile if what we hold is too old.
     * @param onOpen The person asked to look at this profile, so accept less staleness than a row scrolling by would.
     */
    public request(userId: string, { onOpen = false }: { onOpen?: boolean } = {}): Promise<void> {
        const entry = this.entries.get(userId);
        if (entry) {
            const limit = entry.failed ? FAILED_MS : onOpen ? FRESH_ON_OPEN_MS : FRESH_MS;
            if (this.now() - entry.fetchedAt < limit) return Promise.resolve();
        }
        return this.fetch(userId);
    }

    /** Record a profile we have just written ourselves, without waiting for it to be read back. */
    public set(userId: string, raw: Record<string, unknown>): void {
        this.entries.set(userId, { raw, profile: parseRichProfile(raw), fetchedAt: this.now(), failed: false });
        this.notify(userId);
    }

    /** Forget what we hold and fetch again if anyone is showing this person. */
    public invalidate(userId: string): void {
        this.entries.delete(userId);
        if (this.listeners.has(userId)) void this.fetch(userId);
    }

    /**
     * Tell people who may be looking at our profile that it changed. This only prompts them to re-read it from the
     * homeserver, and is sent encrypted so it can be attributed to us.
     */
    public async announceUpdate(): Promise<void> {
        const crypto = this.client.getCrypto();
        if (!crypto) return;
        const recipients = selectPresenceRecipients(this.client);
        if (!recipients.length) return;
        const deviceMap = await crypto.getUserDeviceInfo(recipients, true);
        const devices: { userId: string; deviceId: string }[] = [];
        for (const [userId, userDevices] of deviceMap) {
            for (const [deviceId, device] of userDevices) {
                if (!device.dehydrated) devices.push({ userId, deviceId });
            }
        }
        if (!devices.length) return;
        const batch = await crypto.encryptToDeviceMessages(PROFILE_UPDATED_EVENT_TYPE, devices, { v: 1 });
        if (batch.batch.length) await this.client.queueToDevice(batch);
    }

    private fetch(userId: string): Promise<void> {
        const running = this.inFlight.get(userId);
        if (running) return running;
        const task = this.whenSlotFree()
            .then(() => this.load(userId))
            .finally(() => {
                this.inFlight.delete(userId);
                this.active--;
                this.queue.shift()?.();
            });
        this.inFlight.set(userId, task);
        return task;
    }

    private whenSlotFree(): Promise<void> {
        if (this.active < MAX_CONCURRENT) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve) =>
            this.queue.push(() => {
                this.active++;
                resolve();
            }),
        );
    }

    private async load(userId: string): Promise<void> {
        let raw: Record<string, unknown> = {};
        let failed = false;
        try {
            this.supported ??= this.client.doesServerSupportExtendedProfiles();
            if (await this.supported) raw = await this.client.getExtendedProfile(userId);
        } catch (error) {
            failed = true;
            // A person with an empty or private profile is routine; anything else is worth a line in the logs.
            if (!(error instanceof MatrixError && ["M_NOT_FOUND", "M_FORBIDDEN"].includes(error.errcode ?? ""))) {
                logger.warn(`Could not load the profile of ${userId}`, error);
            }
        }
        this.entries.set(userId, {
            raw,
            profile: failed ? EMPTY_RICH_PROFILE : parseRichProfile(raw),
            fetchedAt: this.now(),
            failed,
        });
        this.notify(userId);
    }

    private notify(userId: string): void {
        for (const listener of this.listeners.get(userId) ?? []) listener();
    }

    private readonly onSyncUpdate = (userId: string): void => this.invalidate(userId);

    private readonly onToDevice = ({ message, encryptionInfo }: ReceivedToDeviceMessage): void => {
        if (message.type !== PROFILE_UPDATED_EVENT_TYPE) return;
        // Plaintext to-device events carry no proof of origin beyond the server's word.
        const sender = encryptionInfo?.sender;
        if (!sender || sender !== message.sender || sender === this.client.getUserId()) return;
        if (this.client.isUserIgnored(sender) || !sharesJoinedRoom(this.client, sender)) return;
        const now = this.now();
        if (now - (this.lastHint.get(sender) ?? 0) < HINT_INTERVAL_MS) return;
        this.lastHint.set(sender, now);
        this.invalidate(sender);
    };
}
