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
/** Our own profile is kept between restarts, so the account dock and profile editor can show it before any request. */
const OWN_PROFILE_KEY = "aether_own_rich_profile";

function readOwnProfile(userId: string): Record<string, unknown> | undefined {
    try {
        const stored = JSON.parse(window.localStorage.getItem(OWN_PROFILE_KEY) ?? "null");
        if (stored?.userId === userId && stored.raw && typeof stored.raw === "object") return stored.raw;
    } catch {
        // Unreadable storage only costs us the head start.
    }
    return undefined;
}

function writeOwnProfile(userId: string, raw: Record<string, unknown>): void {
    try {
        window.localStorage.setItem(OWN_PROFILE_KEY, JSON.stringify({ userId, raw }));
    } catch {
        // Full or blocked storage only costs us the head start.
    }
}

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

    /**
     * Ends the session this client signed in with. Its store forgets everything, and lookups or saves that finish
     * later are dropped, so they cannot write a previous account's profile back after logout. A later session on the
     * same client starts a fresh store.
     */
    public static endSession(client: MatrixClient): void {
        const store = RichProfileStore.stores.get(client);
        RichProfileStore.stores.delete(client);
        store?.end();
    }

    private readonly entries = new LruCache<string, Entry>(CACHE_SIZE);
    private readonly listeners = new Map<string, Set<() => void>>();
    private readonly inFlight = new Map<string, { version: number; task: Promise<void> }>();
    /** Bumped whenever what we hold for a person is replaced or invalidated, so older lookups cannot overwrite it. */
    private readonly versions = new Map<string, number>();
    private readonly queue: (() => void)[] = [];
    private readonly lastHint = new Map<string, number>();
    private active = 0;
    private supported?: Promise<boolean>;

    private ended = false;

    public constructor(
        private readonly client: MatrixClient,
        private readonly now: () => number = Date.now,
    ) {
        client.on(ClientEvent.UserProfileUpdate, this.onSyncUpdate);
        client.on(ClientEvent.ReceivedToDeviceMessage, this.onToDevice);
        const ownId = client.getUserId();
        const ownRaw = ownId ? readOwnProfile(ownId) : undefined;
        // Stored copies count as stale, so the first request for them still goes to the server.
        if (ownId && ownRaw) {
            this.entries.set(ownId, { raw: ownRaw, profile: parseRichProfile(ownRaw), fetchedAt: 0, failed: false });
        }
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
        if (this.ended) return;
        this.bump(userId);
        this.entries.set(userId, { raw, profile: parseRichProfile(raw), fetchedAt: this.now(), failed: false });
        if (userId === this.client.getUserId()) writeOwnProfile(userId, raw);
        this.notify(userId);
    }

    /** Forget what we hold and fetch again if anyone is showing this person. */
    public invalidate(userId: string): void {
        this.bump(userId);
        const entry = this.entries.get(userId);
        // Our own profile keeps showing while it is re-read, since it is on screen almost all the time.
        if (entry && userId === this.client.getUserId() && !entry.failed) entry.fetchedAt = 0;
        else this.entries.delete(userId);
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

    private end(): void {
        this.ended = true;
        this.client.off(ClientEvent.UserProfileUpdate, this.onSyncUpdate);
        this.client.off(ClientEvent.ReceivedToDeviceMessage, this.onToDevice);
        this.entries.clear();
        // Emptied in place, so a notification already running stops calling them.
        for (const set of this.listeners.values()) set.clear();
        this.listeners.clear();
        this.versions.clear();
        this.lastHint.clear();
    }

    private bump(userId: string): void {
        this.versions.set(userId, (this.versions.get(userId) ?? 0) + 1);
    }

    private fetch(userId: string): Promise<void> {
        if (this.ended) return Promise.resolve();
        const version = this.versions.get(userId) ?? 0;
        const running = this.inFlight.get(userId);
        if (running?.version === version) return running.task;
        // A lookup started before the latest change cannot be used, so ask again once it is done.
        if (running) return running.task.then(() => this.fetch(userId));
        const task = this.whenSlotFree()
            .then(() => this.load(userId, version))
            .finally(() => {
                if (this.inFlight.get(userId)?.task === task) this.inFlight.delete(userId);
                this.active--;
                this.queue.shift()?.();
            });
        this.inFlight.set(userId, { version, task });
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

    private async load(userId: string, version: number): Promise<void> {
        // A lookup queued or chained before the session ended does not reach the network.
        if (this.ended) return;
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
        // Something newer replaced or invalidated this person meanwhile, or the session ended.
        if (this.ended || (this.versions.get(userId) ?? 0) !== version) return;
        const own = userId === this.client.getUserId();
        const previous = this.entries.get(userId);
        if (failed && own && previous && !previous.failed) {
            // Keep showing what we last knew of ourselves; only the next request should try again.
            this.entries.set(userId, { ...previous, fetchedAt: 0 });
            return;
        }
        this.entries.set(userId, {
            raw,
            profile: failed ? EMPTY_RICH_PROFILE : parseRichProfile(raw),
            fetchedAt: this.now(),
            failed,
        });
        if (own && !failed) writeOwnProfile(userId, raw);
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
