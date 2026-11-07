/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * Sliding Sync Architecture - MSC https://github.com/matrix-org/matrix-spec-proposals/pull/3575
 *
 * This is a holistic summary of the changes made to Element-Web / React SDK / JS SDK to enable sliding sync.
 * This summary will hopefully signpost where developers need to look if they want to make changes to this code.
 *
 * At the lowest level, the JS SDK contains an HTTP API wrapper function in client.ts. This is used by
 * a SlidingSync class in JS SDK, which contains code to handle list operations (INSERT/DELETE/SYNC/etc)
 * and contains the main request API bodies, but has no code to control updating JS SDK structures: it just
 * exposes an EventEmitter to listen for updates. When MatrixClient.startClient is called, callers need to
 * provide a SlidingSync instance as this contains the main request API params (timeline limit, required state,
 * how many lists, etc).
 *
 * The SlidingSyncSdk INTERNAL class in JS SDK attaches listeners to SlidingSync to update JS SDK Room objects,
 * and it conveniently exposes an identical public API to SyncApi (to allow it to be a drop-in replacement).
 *
 * At the highest level, SlidingSyncManager contains mechanisms to tell UI lists which rooms to show,
 * and contains the core request API params used in Element-Web. It does this by listening for events
 * emitted by the SlidingSync class and by modifying the request API params on the SlidingSync class.
 *
 *    (entry point)                     (updates JS SDK)
 *  SlidingSyncManager                   SlidingSyncSdk
 *       |                                     |
 *       +------------------.------------------+
 *         listens          |          listens
 *                     SlidingSync
 *                     (sync loop,
 *                      list ops)
 */

import {
    type MatrixClient,
    type MatrixEvent,
    ClientEvent,
    EventType,
    type Room,
    RoomEvent,
    RoomStateEvent,
    SyncState,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { sortBy } from "lodash";

import {
    type MSC3575Filter,
    type MSC3575List,
    type MSC3575RoomData,
    type MSC3575SlidingSyncResponse,
    MSC3575_STATE_KEY_LAZY,
    MSC3575_STATE_KEY_ME,
    MSC3575_WILDCARD,
    SlidingSync,
    SlidingSyncEvent,
    SlidingSyncState,
    type SlidingSyncSnapshot,
} from "matrix-js-sdk/src/sliding-sync";
import { logger } from "matrix-js-sdk/src/logger";
import { sleep } from "matrix-js-sdk/src/utils";

import SettingsStore from "./settings/SettingsStore";
import { getChildOrder } from "./stores/spaces/childOrder";

import {
    CATALOG_STATE,
    ENCRYPTED_SUBSCRIPTION,
    NAMED_SUBSCRIPTIONS,
    RoomSubscriptionName,
} from "./sliding-sync/roomStateProfiles";
import { RoomSubscriptionLeases, type RoomSubscriptionLease } from "./sliding-sync/RoomSubscriptionLeases";
import { SlidingSyncCache } from "./sliding-sync/SlidingSyncCache";
import { NotificationCountEngine } from "./sliding-sync/notification-counts/NotificationCountEngine";

// how long to long poll for
const SLIDING_SYNC_TIMEOUT_MS = 20 * 1000;

// Most rooms are listed with only their latest event: enough for the room list, and small enough to list every room
// quickly. The rooms someone is most likely to open next get more, through the "recent" lists and subscriptions.
const LIST_TIMELINE_LIMIT = 1;

// The most recently active rooms are listed with enough history to open them before a subscription returns.
const RECENT_TIMELINE_LIMIT = 20;
const RECENT_ROOMS = 20;

// Rooms are listed in batches of this size, after the first page of each list.
const SPIDER_BATCH_SIZE = 100;
const SPIDER_GAP_MS = 50;

// Changes to subscriptions nobody is waiting for are sent together, at most this often. Each change interrupts the
// long poll, so pointing at rooms or switching Spaces quickly must not send a request each.
const SUBSCRIPTION_BATCH_MS = 150;

// How long to wait for a room nobody has seen before letting the room view show what it can.
const ROOM_DISCOVERY_TIMEOUT_MS = 10_000;

// The channels of the Space someone is looking at are subscribed, so they appear before the whole account is
// listed. They are read from the Space's own state: homeservers do not filter lists by Space, and Synapse fails the
// whole request when asked to.
const MAX_SPACE_CHANNELS = 200;
// How many of a Space tree's children are looked at, so a huge Space costs little each time it changes.
const MAX_SPACE_TREE_VISITS = 1000;
// Changes to the Space tree outside a sync response, such as rooms restored from this device, are read after this
// pause, so a burst of them costs one walk.
const SPACE_TREE_SETTLE_MS = 50;
// A response still being applied after this long is treated as over: its processing failed or the connection stopped.
const RESPONSE_STALL_MS = 15_000;

/** How a room someone opened was found. */
export type RoomVisibility =
    /** The room is known and its subscription has been asked for. */
    | "known"
    /** The server answered without the room: the user cannot see it, or it does not exist. */
    | "absent"
    /** The server has not answered in time. The room may still arrive. */
    | "timeout"
    /** The client or connection was replaced while waiting. */
    | "replaced";

// the complete set of lists made in SSS. The manager will spider all of these lists depending
// on the count for each one, except for the recent list which stays at its first page.
const sssLists: Record<string, MSC3575List> = {
    recent: {
        ranges: [[0, RECENT_ROOMS - 1]],
        timeline_limit: RECENT_TIMELINE_LIMIT,
        required_state: CATALOG_STATE,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: CATALOG_STATE,
        },
        filters: {
            is_invite: false,
            not_room_types: ["m.space"],
        },
    },
    spaces: {
        ranges: [[0, 10]],
        timeline_limit: 0, // we don't care about the most recent message for spaces
        required_state: CATALOG_STATE,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: CATALOG_STATE,
        },
        filters: {
            room_types: ["m.space"],
        },
    },
    invites: {
        ranges: [[0, 10]],
        timeline_limit: 1, // most recent message display
        required_state: CATALOG_STATE,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: CATALOG_STATE,
        },
        filters: {
            is_invite: true,
        },
    },
    favourites: {
        ranges: [[0, 10]],
        timeline_limit: LIST_TIMELINE_LIMIT,
        required_state: CATALOG_STATE,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: CATALOG_STATE,
        },
        filters: {
            tags: ["m.favourite"],
        },
    },
    dms: {
        ranges: [[0, 10]],
        timeline_limit: LIST_TIMELINE_LIMIT,
        required_state: CATALOG_STATE,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: CATALOG_STATE,
        },
        filters: {
            is_dm: true,
            is_invite: false,
            // If a DM has a Favourite & Low Prio tag then it'll be shown in those lists instead
            not_tags: ["m.favourite", "m.lowpriority"],
        },
    },
    untagged: {
        // SSS will dupe suppress invites/dms from here, so we don't need "not dms, not invites"
        ranges: [[0, 10]],
        timeline_limit: LIST_TIMELINE_LIMIT,
        required_state: CATALOG_STATE,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: CATALOG_STATE,
        },
    },
};

/** Lists whose range stays at its first page while the others grow to every room. */
const FIXED_LISTS = new Set(["recent"]);

export type PartialSlidingSyncRequest = {
    filters?: MSC3575Filter;
    sort?: string[];
    ranges?: [startIndex: number, endIndex: number][];
};

/**
 * This class manages the entirety of sliding sync at a high UI/UX level. It controls the placement
 * of placeholders in lists, controls updating sliding window ranges, and controls which events
 * are pulled down when. The intention behind this manager is be the single place to look for sliding
 * sync options and code.
 *
 * Rooms are subscribed through leases: the room someone is viewing, the rooms of their calls, the Space they are
 * looking at and the rooms they are about to open. Released rooms stay subscribed for a grace period and are then
 * dropped, so the subscriptions of a long session stay bounded.
 */
/** Where the server's last answer about offering sliding sync is kept, per homeserver. */
function supportKey(client: MatrixClient): string {
    return `mx_sliding_sync_offered:${client.baseUrl}`;
}

export class SlidingSyncManager {
    public static serverSupportsSlidingSync: boolean;

    public static readonly ListSpaces = "space_list";
    public static readonly ListSearch = "search_list";
    private static readonly internalInstance = new SlidingSyncManager();

    public slidingSync?: SlidingSync;
    private client?: MatrixClient;
    private readonly bootstrapRooms = new Set<string>();
    private readonly roomWaiters = new Set<() => void>();
    private readonly initialTimelines = new Map<
        string,
        {
            promise: Promise<boolean>;
            resolve: (expanded: boolean) => void;
            phase: "initial" | "expanding";
            received: boolean;
            needsExpansion: boolean;
            timeout?: ReturnType<typeof setTimeout>;
        }
    >();
    private cancelInitialPreparations?: () => void;

    private leases = new RoomSubscriptionLeases(() => {});
    private viewLease?: RoomSubscriptionLease;
    private spaceLease?: RoomSubscriptionLease;
    private readonly callLeases = new Map<string, RoomSubscriptionLease>();
    // Rooms the crypto layer says are encrypted, even before their encryption state has arrived.
    private readonly encryptedRooms = new Set<string>();
    // Rooms we were told are Spaces before we have seen them.
    private readonly expectedSpaces = new Set<string>();
    // The subscription each subscribed room was last given.
    private readonly appliedNames = new Map<string, RoomSubscriptionName>();
    private flushQueued = false;
    private flushTimer?: ReturnType<typeof setTimeout>;
    // The Space whose channels are subscribed, the rooms met walking its tree, and the Space asked for before the
    // connection existed.
    private activeSpaceId?: string;
    private spaceTree = new Set<string>();
    private spaceChannels = new Set<string>();
    private spaceTreeChanged = false;
    // Whether every list has grown to cover the whole account, so known rooms are kept up to date by the lists.
    private listsCoverAccount = false;
    // Rooms the server answered a subscription without, until they arrive after all.
    private readonly absentRooms = new Set<string>();
    // Saved channels already asked to be applied in the background, so each is asked for once.
    private readonly savedChannelsAsked = new Set<string>();
    // Rooms the server has sent data for on this connection, and saved rooms it turned out the user had left while
    // this device was away.
    private readonly liveRooms = new Set<string>();
    // Rooms the response being applied has data for, published once it has been applied.
    private readonly arrivingLiveRooms = new Set<string>();
    private readonly leftWhileAway = new Set<string>();
    // Told when it changes whether a room may still arrive or has, such as for a channel opened before it arrived.
    private readonly arrivalListeners = new Set<() => void>();
    // When the sync response being applied arrived, and the pending read of changes made outside one.
    private applyingSince?: number;
    private spaceTreeTimer?: ReturnType<typeof setTimeout>;
    // Each walked Space's children in the Space's order, with the child events they were sorted from.
    private readonly sortedChildren = new Map<string, { events: MatrixEvent[]; sorted: MatrixEvent[] }>();
    private pendingActiveSpace?: string;
    // The rooms the app opens at start, restored from this device before the others.
    private roomsShownFirst: string[] = [];

    private configureDefer = Promise.withResolvers<void>();

    // What this device keeps of the session's rooms, shown at the next start before the server answers.
    private cache?: SlidingSyncCache;
    // A cache whose saved rooms are already being read, before the client is set up, and that read.
    private prefetched?: {
        client: MatrixClient;
        cache: SlidingSyncCache;
        snapshot: Promise<SlidingSyncSnapshot | null>;
    };
    private detachCache?: () => void;
    private countEngine?: NotificationCountEngine;

    public static get instance(): SlidingSyncManager {
        return SlidingSyncManager.internalInstance;
    }

    private configure(client: MatrixClient, proxyUrl: string, initialRoomId?: string): SlidingSync {
        this.detachCache?.();
        this.detachCache = undefined;
        this.cancelInitialPreparations?.();
        this.initialTimelines.clear();
        for (const settle of this.roomWaiters) settle();
        this.client?.off(RoomStateEvent.Events, this.onSpaceState);
        this.client?.off(ClientEvent.Room, this.onRoomStored);
        this.client?.off(RoomEvent.MyMembership, this.onMyMembership);
        this.client?.off(RoomEvent.Redaction, this.onSpaceRedaction);
        this.client?.off(RoomEvent.RedactionCancelled, this.onSpaceRedaction);
        this.client = client;
        client.on(RoomStateEvent.Events, this.onSpaceState);
        client.on(ClientEvent.Room, this.onRoomStored);
        client.on(RoomEvent.MyMembership, this.onMyMembership);
        client.on(RoomEvent.Redaction, this.onSpaceRedaction);
        client.on(RoomEvent.RedactionCancelled, this.onSpaceRedaction);
        this.bootstrapRooms.clear();
        this.encryptedRooms.clear();
        this.expectedSpaces.clear();
        this.appliedNames.clear();
        this.leases.dispose();
        this.leases = new RoomSubscriptionLeases(this.scheduleFlush);
        this.viewLease = undefined;
        this.spaceLease = undefined;
        this.callLeases.clear();
        this.activeSpaceId = undefined;
        this.listsCoverAccount = false;
        this.absentRooms.clear();
        this.savedChannelsAsked.clear();
        this.liveRooms.clear();
        this.arrivingLiveRooms.clear();
        this.leftWhileAway.clear();
        this.spaceTree = new Set();
        this.spaceChannels = new Set();
        this.stopFollowingSpaceTree();
        if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        this.flushQueued = false;
        // create the set of lists we will use.
        const lists = new Map();
        for (const listName in sssLists) {
            // A resolved destination takes priority over background room discovery on the first response.
            if (initialRoomId?.startsWith("!")) break;
            lists.set(listName, {
                ...sssLists[listName],
                ranges: [[0, 0]],
                timeline_limit: listName === "spaces" ? 0 : 1,
            });
        }
        // by default use the encrypted subscription as that gets everything, which is a safer
        // default than potentially missing member events.
        this.slidingSync = new SlidingSync(proxyUrl, lists, ENCRYPTED_SUBSCRIPTION, client, SLIDING_SYNC_TIMEOUT_MS);
        for (const [name, subscription] of NAMED_SUBSCRIPTIONS) {
            this.slidingSync.addCustomSubscription(name, subscription);
        }
        this.trackInitialTimelines(this.slidingSync);
        // Responses are followed from the start, so a change is never read while one is half applied.
        this.slidingSync.on(SlidingSyncEvent.Lifecycle, this.onResponseApplied);
        this.slidingSync.on(SlidingSyncEvent.RoomData, this.onLiveRoomData);
        // The server's counts are not real (Synapse sends zero), so they are worked out here.
        this.countEngine?.stop();
        const countEngine = new NotificationCountEngine(client, this.slidingSync);
        this.countEngine = countEngine;
        countEngine.start();
        const ownedSync = this.slidingSync;
        // SlidingSync has no stopped event. Settle waits before our owned instance stops.
        const stop = ownedSync.stop.bind(ownedSync);
        ownedSync.stop = (): void => {
            if (this.slidingSync === ownedSync) {
                this.cancelInitialPreparations?.();
                for (const settle of this.roomWaiters) settle();
                this.stopFollowingSpaceTree();
            }
            ownedSync.off(SlidingSyncEvent.Lifecycle, this.onResponseApplied);
            ownedSync.off(SlidingSyncEvent.RoomData, this.onLiveRoomData);
            countEngine.stop();
            stop();
        };
        this.configureDefer.resolve();
        return this.slidingSync;
    }

    /**
     * Preparation of this client's first room timeline. True means native expansion was processed.
     * A view mounted after completion can load the expanded cached timeline immediately.
     */
    public initialTimelinePreparation(client: MatrixClient, roomId: string): Promise<boolean> | undefined {
        return this.client === client ? this.initialTimelines.get(roomId)?.promise : undefined;
    }

    private beginInitialTimeline(roomId: string): void {
        this.bootstrapRooms.add(roomId);
        if (this.initialTimelines.has(roomId)) return;
        const { promise, resolve } = Promise.withResolvers<boolean>();
        this.initialTimelines.set(roomId, {
            promise,
            resolve,
            phase: "initial",
            received: false,
            needsExpansion: false,
        });
        if (!this.cancelInitialPreparations && this.slidingSync) this.trackInitialTimelines(this.slidingSync);
    }

    private settleInitialTimeline(roomId: string, expanded: boolean): void {
        const preparation = this.initialTimelines.get(roomId);
        if (!preparation) return;
        clearTimeout(preparation.timeout);
        this.initialTimelines.delete(roomId);
        if (preparation.phase === "expanding" && this.slidingSync) {
            const room = this.client?.getRoom(roomId);
            if (room) this.upgradeDiscoveredRoom(room);
            else this.scheduleFlush(true);
        }
        preparation.resolve(expanded);
        if (this.initialTimelines.size === 0) this.cancelInitialPreparations?.();
    }

    /** Expand only a public notice-only tail, after its first response has reached SDK rooms. */
    private trackInitialTimelines(slidingSync: SlidingSync): void {
        const onRoomData = (roomId: string, data: MSC3575RoomData): void => {
            const preparation = this.initialTimelines.get(roomId);
            if (!preparation) return;
            preparation.received = true;
            preparation.needsExpansion =
                (data.timeline?.length ?? 0) > 0 &&
                !(data.required_state ?? []).some(
                    (event) =>
                        event.type === EventType.RoomEncryption ||
                        (event.type === EventType.RoomCreate && event.content?.type === "m.space") ||
                        (event.type === EventType.RoomMember &&
                            event.state_key === this.client?.getUserId() &&
                            ["leave", "ban"].includes(event.content?.membership ?? "")),
                ) &&
                !(data.timeline ?? []).some(
                    (event) =>
                        event.unsigned?.redacted_because === undefined &&
                        !("state_key" in event) &&
                        event.type !== EventType.RoomMember &&
                        event.type !== EventType.RoomRedaction &&
                        event.content?.["m.relates_to"]?.rel_type !== "m.replace" &&
                        event.type !== EventType.Reaction,
                );
        };
        const onComplete = (
            state: SlidingSyncState,
            response: MSC3575SlidingSyncResponse | null,
            error?: Error,
        ): void => {
            if (error) {
                for (const roomId of this.initialTimelines.keys()) this.settleInitialTimeline(roomId, false);
                return;
            }
            if (state !== SlidingSyncState.Complete) return;
            if (this.initialTimelines.size === 0) {
                cancel();
                return;
            }
            if (!response) return;
            for (const [roomId, preparation] of this.initialTimelines) {
                if (
                    preparation.phase === "initial" &&
                    preparation.received &&
                    preparation.needsExpansion &&
                    !this.client?.getRoom(roomId)?.hasEncryptionStateEvent()
                ) {
                    preparation.phase = "expanding";
                    preparation.received = false;
                    // The longer look back must reach the very next request, ahead of background lists.
                    this.applySubscriptions(slidingSync);
                    // Native expansion must not indefinitely suppress ordinary history pagination.
                    preparation.timeout = setTimeout(() => this.settleInitialTimeline(roomId, false), 3000);
                    continue;
                }
                if (
                    preparation.phase === "expanding" &&
                    !preparation.received &&
                    slidingSync.getRoomSubscriptions().has(roomId)
                )
                    continue;
                const expanded = preparation.phase === "expanding" && preparation.received;
                this.settleInitialTimeline(roomId, expanded);
                if (!response.rooms[roomId]) this.bootstrapRooms.delete(roomId);
            }
            if (this.initialTimelines.size === 0) cancel();
        };
        slidingSync.on(SlidingSyncEvent.RoomData, onRoomData);
        slidingSync.on(SlidingSyncEvent.Lifecycle, onComplete);
        let active = true;
        const cancel = (): void => {
            if (!active) return;
            active = false;
            slidingSync.off(SlidingSyncEvent.RoomData, onRoomData);
            slidingSync.off(SlidingSyncEvent.Lifecycle, onComplete);
            for (const preparation of this.initialTimelines.values()) {
                clearTimeout(preparation.timeout);
                preparation.resolve(false);
            }
            this.initialTimelines.clear();
            if (this.cancelInitialPreparations === cancel) this.cancelInitialPreparations = undefined;
        };
        this.cancelInitialPreparations = cancel;
    }

    /**
     * Send subscription changes. Changes someone is waiting for go out with the next request; the rest are batched.
     * @param urgent - True when someone has just opened a room or joined a call.
     */
    private scheduleFlush = (urgent: boolean): void => {
        if (!this.slidingSync) return;
        if (urgent) {
            if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
            if (this.flushQueued) return;
            this.flushQueued = true;
            queueMicrotask(() => {
                this.flushQueued = false;
                if (this.slidingSync) this.applySubscriptions(this.slidingSync);
            });
            return;
        }
        if (this.flushQueued || this.flushTimer !== undefined) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            if (this.slidingSync) this.applySubscriptions(this.slidingSync);
        }, SUBSCRIPTION_BATCH_MS);
    };

    /** The subscription a room should have, from what it is and why it is subscribed. */
    private subscriptionNameFor(roomId: string): RoomSubscriptionName {
        if (this.initialTimelines.get(roomId)?.phase === "expanding") return RoomSubscriptionName.ExpandedBootstrap;
        const room = this.client?.getRoom(roomId);
        if (this.expectedSpaces.has(roomId) || room?.isSpaceRoom()) return RoomSubscriptionName.Space;
        if (this.spaceChannels.has(roomId) && !this.bootstrapRooms.has(roomId) && !this.leases.has(roomId)) {
            // Only listed because its Space is open. A room given more history keeps it: a smaller subscription
            // would be sent again for nothing.
            const applied = this.appliedNames.get(roomId);
            return applied === RoomSubscriptionName.Room ||
                applied === RoomSubscriptionName.Encrypted ||
                applied === RoomSubscriptionName.Prefetch
                ? applied
                : RoomSubscriptionName.Channel;
        }
        if (!room || this.bootstrapRooms.has(roomId)) return RoomSubscriptionName.Bootstrap;
        if (room.hasEncryptionStateEvent() || this.encryptedRooms.has(roomId)) return RoomSubscriptionName.Encrypted;
        const purposes = this.leases.purposes(roomId);
        if (purposes.has("view") || purposes.has("call") || purposes.has("space")) return RoomSubscriptionName.Room;
        // A room that is only likely to be opened, or kept for its grace period, never loses history it was given:
        // a smaller subscription would be sent again for nothing.
        const applied = this.appliedNames.get(roomId);
        if (
            applied &&
            applied !== RoomSubscriptionName.Prefetch &&
            applied !== RoomSubscriptionName.Space &&
            applied !== RoomSubscriptionName.Channel
        ) {
            return RoomSubscriptionName.Room;
        }
        return RoomSubscriptionName.Prefetch;
    }

    /** Bring the connection's room subscriptions in line with the leases, sending a request only if they changed. */
    private applySubscriptions(slidingSync: SlidingSync): void {
        if (this.slidingSync !== slidingSync) return;
        const desired = new Set(this.leases.roomIds());
        for (const roomId of this.spaceChannels) desired.add(roomId);
        for (const roomId of this.bootstrapRooms) desired.add(roomId);
        for (const roomId of this.initialTimelines.keys()) desired.add(roomId);
        let changed = false;
        for (const roomId of desired) {
            const name = this.subscriptionNameFor(roomId);
            if (this.appliedNames.get(roomId) === name) continue;
            this.appliedNames.set(roomId, name);
            slidingSync.useCustomSubscription(roomId, name);
            changed = true;
        }
        for (const roomId of this.appliedNames.keys()) {
            if (!desired.has(roomId)) this.appliedNames.delete(roomId);
        }
        const current = slidingSync.getRoomSubscriptions();
        if (!changed && current.size === desired.size && [...desired].every((roomId) => current.has(roomId))) return;
        slidingSync.modifyRoomSubscriptions(desired);
    }

    /**
     * Ensure that this list is registered.
     * @param listKey The list key to register
     * @param updateArgs The fields to update on the list.
     * @returns The complete list request params
     */
    public async ensureListRegistered(listKey: string, updateArgs: PartialSlidingSyncRequest): Promise<MSC3575List> {
        logger.debug("ensureListRegistered:::", listKey, updateArgs);
        await this.configureDefer.promise;
        let list = this.slidingSync!.getListParams(listKey);
        if (!list) {
            list = {
                ranges: [[0, 20]],
                sort: ["by_notification_level", "by_recency"],
                timeline_limit: LIST_TIMELINE_LIMIT,
                required_state: [
                    [EventType.RoomJoinRules, ""], // the public icon on the room list
                    [EventType.RoomAvatar, ""], // any room avatar
                    [EventType.RoomTombstone, ""], // lets JS SDK hide rooms which are dead
                    [EventType.RoomEncryption, ""], // lets rooms be configured for E2EE correctly
                    [EventType.RoomCreate, ""], // for isSpaceRoom checks
                    [EventType.RoomMember, MSC3575_STATE_KEY_ME], // lets the client calculate that we are in fact in the room
                    [EventType.RoomMember, MSC3575_STATE_KEY_LAZY], // senders in the cached timeline
                ],
                include_old_rooms: {
                    timeline_limit: 0,
                    required_state: [
                        [EventType.RoomCreate, ""],
                        [EventType.RoomTombstone, ""], // lets JS SDK hide rooms which are dead
                        [EventType.SpaceChild, MSC3575_WILDCARD], // all space children
                        [EventType.SpaceParent, MSC3575_WILDCARD], // all space parents
                        [EventType.RoomMember, MSC3575_STATE_KEY_ME], // lets the client calculate that we are in fact in the room
                    ],
                },
                ...updateArgs,
            };
        } else {
            const updatedList = { ...list, ...updateArgs };
            // cannot use objectHasDiff as we need to do deep diff checking
            if (JSON.stringify(list) === JSON.stringify(updatedList)) {
                logger.debug("list matches, not sending, update => ", updateArgs);
                return list;
            }
            list = updatedList;
        }

        try {
            // if we only have range changes then call a different function so we don't nuke the list from before
            if (updateArgs.ranges && Object.keys(updateArgs).length === 1) {
                this.slidingSync!.setListRanges(listKey, updateArgs.ranges);
            } else {
                this.slidingSync!.setList(listKey, list);
            }
        } catch (err) {
            logger.debug("ensureListRegistered: update failed txn_id=", err);
        }
        return this.slidingSync!.getListParams(listKey)!;
    }

    /**
     * Announces that the user has chosen to view the given room and that room will now
     * be displayed, so it should have more state loaded. The previously viewed room is released, and stays
     * subscribed for a grace period.
     * @param roomId The room to set visible
     * @returns How the room was found. Waits for a room nobody has seen yet, until the server sends it, answers
     * without it, or takes too long.
     */
    public async setRoomVisible(roomId: string): Promise<RoomVisibility> {
        await this.configureDefer.promise;
        const client = this.client!;
        const slidingSync = this.slidingSync!;
        if (this.viewLease?.roomId !== roomId) {
            const previous = this.viewLease;
            this.viewLease = this.leases.acquire(roomId, "view");
            previous?.release();
        }

        let room = client.getRoom(roomId);
        if (!room && slidingSync.hasSavedRoom(roomId)) {
            // This device's saved data for the room still waits its turn, such as a Space's channel restored in
            // the background. Applying it now shows the room without waiting for the server.
            await slidingSync.restoreSavedRooms([roomId]);
            if (this.client !== client || this.slidingSync !== slidingSync) return "replaced";
            room = client.getRoom(roomId);
        }
        if (room) {
            // The crypto layer remembers encryption even if the room's state is incomplete or was removed.
            if (!room.hasEncryptionStateEvent() && (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId))) {
                this.encryptedRooms.add(roomId);
                this.scheduleFlush(true);
            }
            if (this.client !== client || this.slidingSync !== slidingSync) return "replaced";
            logger.log("SlidingSync setRoomVisible:", roomId);
            return "known"; // we have data already for this room, show immediately e.g it's in a list
        }

        // Unknown rooms first fetch encryption metadata and lazy members, then upgrade once discovered.
        logger.log("SlidingSync setRoomVisible: waiting for", roomId);
        this.beginInitialTimeline(roomId);
        this.scheduleFlush(true);
        return this.waitForRoom(client, slidingSync, roomId);
    }

    /**
     * Wait until a room is known, the server answers a request carrying its subscription without it, or the wait
     * times out.
     */
    private waitForRoom(client: MatrixClient, slidingSync: SlidingSync, roomId: string): Promise<RoomVisibility> {
        return new Promise((resolve) => {
            const settle = (outcome: RoomVisibility): void => {
                client.off(ClientEvent.Room, onRoom);
                slidingSync.off(SlidingSyncEvent.Lifecycle, onLifecycle);
                clearTimeout(timer);
                this.roomWaiters.delete(onReplaced);
                resolve(outcome);
            };
            const onReplaced = (): void => settle("replaced");
            const onRoom = (r: Room): void => {
                if (this.client !== client || this.slidingSync !== slidingSync) {
                    settle("replaced");
                    return;
                }
                if (r.roomId !== roomId) return;
                this.upgradeDiscoveredRoom(r);
                settle("known");
            };
            const onLifecycle = (
                state: SlidingSyncState,
                response: MSC3575SlidingSyncResponse | null,
                error?: Error,
            ): void => {
                if (state !== SlidingSyncState.Complete || !response || error) return;
                if (client.getRoom(roomId)) {
                    settle("known");
                    return;
                }
                if (!slidingSync.isRoomSubscriptionConfirmed(roomId) || response.rooms?.[roomId]) return;
                // The server has answered this subscription without the room. Stop asking for its history.
                logger.log("SlidingSync setRoomVisible: the server did not send", roomId);
                this.absentRooms.add(roomId);
                this.notifyArrivals();
                this.bootstrapRooms.delete(roomId);
                this.settleInitialTimeline(roomId, false);
                settle("absent");
            };
            this.roomWaiters.add(onReplaced);
            client.on(ClientEvent.Room, onRoom);
            slidingSync.on(SlidingSyncEvent.Lifecycle, onLifecycle);
            const timer = setTimeout(() => {
                logger.warn("SlidingSync setRoomVisible: timed out waiting for", roomId);
                settle("timeout");
            }, ROOM_DISCOVERY_TIMEOUT_MS);
        });
    }

    /**
     * Note that someone is likely to open a room soon, such as by pointing at it in the room list. Its history is
     * fetched in the background, so it opens straight away. Does nothing without sliding sync.
     * @param roomId - The room they may open.
     */
    public prefetchRoom(roomId: string): void {
        if (!this.slidingSync || !roomId.startsWith("!")) return;
        if (this.viewLease?.roomId === roomId) return;
        this.leases.prefetch(roomId);
    }

    /**
     * Whether sliding sync may still bring a room this client does not know yet, such as a channel its lists have
     * not reached, or one this device saved that is not applied yet.
     * @param roomId - The room.
     * @returns False without sliding sync, for a room the client knows, and for one the server answered without.
     */
    public mayStillArrive(roomId: string): boolean {
        const client = this.client;
        const slidingSync = this.slidingSync;
        if (!client || !slidingSync || client.getRoom(roomId)) return false;
        if (slidingSync.hasSavedRoom(roomId)) return true;
        return !this.listsCoverAccount && !this.absentRooms.has(roomId);
    }

    /**
     * Whether the server has sent data for a room on this connection, rather than the room only being restored from
     * what this device saved.
     * @param roomId - The room.
     */
    public hasLiveData(roomId: string): boolean {
        return this.liveRooms.has(roomId);
    }

    /**
     * Whether a room this device saved turned out to be one the user left, or was removed from, while it was away.
     * @param roomId - The room.
     */
    public wasLeftWhileAway(roomId: string): boolean {
        return this.leftWhileAway.has(roomId);
    }

    /**
     * Be told when what {@link mayStillArrive}, {@link hasLiveData} or {@link wasLeftWhileAway} say may have
     * changed.
     * @param listener - Called after each change.
     * @returns A function that stops telling it.
     */
    public onArrivalChange(listener: () => void): () => void {
        this.arrivalListeners.add(listener);
        return () => this.arrivalListeners.delete(listener);
    }

    /**
     * Keep the rooms of ongoing calls subscribed, so their state and chat stay current while someone reads other
     * rooms. Rooms no longer in a call are released.
     * @param roomIds - The rooms with a call this device is connected to.
     */
    public setCallRooms(roomIds: Iterable<string>): void {
        if (!this.slidingSync) return;
        const wanted = new Set(roomIds);
        for (const [roomId, lease] of this.callLeases) {
            if (wanted.has(roomId)) continue;
            lease.release();
            this.callLeases.delete(roomId);
        }
        for (const roomId of wanted) {
            if (!this.callLeases.has(roomId)) this.callLeases.set(roomId, this.leases.acquire(roomId, "call"));
        }
    }

    /**
     * Load the Space someone is looking at first: its own state, and its channels, so they appear before the rest of
     * the account is listed. The channels of subspaces the user has joined are included, as the Space shows them too.
     * The channels stay subscribed when they go Home.
     * @param spaceId - The Space, or null for Home and other views without one.
     */
    public setActiveSpace(spaceId: string | null): void {
        const previous = this.spaceLease;
        if (!spaceId?.startsWith("!")) {
            this.spaceLease = undefined;
            previous?.release();
            return;
        }
        if (!this.slidingSync) {
            this.pendingActiveSpace = spaceId;
            return;
        }
        if (previous?.roomId !== spaceId) {
            this.spaceLease = this.leases.acquire(spaceId, "space");
            previous?.release();
        }
        this.activeSpaceId = spaceId;
        this.refreshSpaceChannels();
    }

    /**
     * Note a change to a room in the active Space's tree: a Space's children, a room arriving, being upgraded or
     * turning out to be a Space, or the user joining or leaving a subspace. A change a sync response brings is read
     * once the response has been applied, when the SDK has stored every room and worked out every membership. Any
     * other change, such as rooms restored from this device before the first response, is read after a short pause.
     */
    private markSpaceTreeChanged(roomId: string | undefined): void {
        if (!roomId || !this.spaceTree.has(roomId)) return;
        this.spaceTreeChanged = true;
        this.scheduleSpaceTreeRead();
    }

    /** Read changes made outside a response after a short pause, or once a stalled response is given up on. */
    private scheduleSpaceTreeRead(): void {
        if (this.spaceTreeTimer !== undefined || !this.spaceTreeChanged) return;
        const applying = this.applyingSince !== undefined;
        if (applying && Date.now() - this.applyingSince! < RESPONSE_STALL_MS) {
            // Complete reads it. The timer only guards against a response that never completes.
            this.spaceTreeTimer = setTimeout(
                () => {
                    this.spaceTreeTimer = undefined;
                    this.scheduleSpaceTreeRead();
                },
                RESPONSE_STALL_MS - (Date.now() - this.applyingSince!),
            );
            return;
        }
        this.spaceTreeTimer = setTimeout(() => {
            this.spaceTreeTimer = undefined;
            if (this.applyingSince !== undefined && Date.now() - this.applyingSince < RESPONSE_STALL_MS) {
                this.scheduleSpaceTreeRead();
                return;
            }
            this.applyingSince = undefined;
            if (this.spaceTreeChanged) this.refreshSpaceChannels();
        }, SPACE_TREE_SETTLE_MS);
    }

    /** Forget the Space tree's pending reads, such as when the connection stops or is replaced. */
    private stopFollowingSpaceTree(): void {
        this.spaceTreeChanged = false;
        this.applyingSince = undefined;
        if (this.spaceTreeTimer !== undefined) clearTimeout(this.spaceTreeTimer);
        this.spaceTreeTimer = undefined;
        this.sortedChildren.clear();
    }

    private readonly onSpaceState = (event: MatrixEvent): void => {
        const type = event.getType();
        // A child event can change without being replaced, such as when it is redacted, so the order is dropped.
        if (type === EventType.SpaceChild) this.sortedChildren.delete(event.getRoomId()!);
        if (type === EventType.SpaceChild || type === EventType.RoomCreate || type === EventType.RoomTombstone) {
            this.markSpaceTreeChanged(event.getRoomId());
        }
    };

    private readonly onRoomStored = (room: Room): void => {
        this.absentRooms.delete(room.roomId);
        this.markSpaceTreeChanged(room.roomId);
    };

    private readonly onMyMembership = (room: Room): void => {
        // A room rejoined since is the user's again.
        if (room.getMyMembership() === KnownMembership.Join) this.leftWhileAway.delete(room.roomId);
        this.markSpaceTreeChanged(room.roomId);
    };

    // A room's data arrives before the SDK applies it, such as a change of membership: it counts as live once the
    // response has been applied, on Complete.
    private readonly onLiveRoomData = (roomId: string): void => {
        if (!this.liveRooms.has(roomId)) this.arrivingLiveRooms.add(roomId);
    };

    /** Publish the rooms the response just applied had data for. */
    private publishLiveRooms(): void {
        if (this.arrivingLiveRooms.size === 0) return;
        for (const roomId of this.arrivingLiveRooms) this.liveRooms.add(roomId);
        this.arrivingLiveRooms.clear();
        this.notifyArrivals();
    }

    private notifyArrivals(): void {
        for (const listener of this.arrivalListeners) listener();
    }

    /** Redacting a child event, even locally, or cancelling a local redaction, changes it in place. */
    private readonly onSpaceRedaction = (_redaction: MatrixEvent, room: Room): void => {
        this.sortedChildren.delete(room.roomId);
        this.markSpaceTreeChanged(room.roomId);
    };

    private readonly onResponseApplied = (state: SlidingSyncState, _response: unknown, error?: Error): void => {
        if (state === SlidingSyncState.RequestFinished) {
            // A response is applied between its arrival and Complete. A failed request applies nothing.
            this.applyingSince = error ? undefined : Date.now();
            if (error) {
                this.arrivingLiveRooms.clear();
                this.scheduleSpaceTreeRead();
            }
        } else if (state === SlidingSyncState.Complete) {
            this.applyingSince = undefined;
            this.publishLiveRooms();
            if (this.spaceTreeTimer !== undefined) clearTimeout(this.spaceTreeTimer);
            this.spaceTreeTimer = undefined;
            if (this.listsCoverAccount && this.slidingSync && this.listsOutgrown(this.slidingSync)) {
                // A room joined since spidering finished can push the least active one out of every list. Until
                // the lists grow again, joined channels are subscribed as before.
                this.listsCoverAccount = false;
                this.spaceTreeChanged = true;
                void this.startSpidering(this.slidingSync, SPIDER_BATCH_SIZE, SPIDER_GAP_MS);
            }
            if (this.spaceTreeChanged) this.refreshSpaceChannels();
        }
    };

    /** Whether a list that grows to the whole account now has more rooms than its range covers. */
    private listsOutgrown(slidingSync: SlidingSync): boolean {
        return Object.keys(sssLists).some((listName) => {
            if (FIXED_LISTS.has(listName)) return false;
            const upperBound = slidingSync.getListParams(listName)?.ranges[0]?.[1];
            const count = slidingSync.getListData(listName)?.joinedCount ?? 0;
            return upperBound !== undefined && upperBound < count - 1;
        });
    }

    /**
     * A Space's valid children in the Space's own order, as it shows them. Sorting looks at every child, so the
     * order is kept while the Space's child events are the same ones, which is much cheaper to check.
     */
    private childrenInOrder(space: Room): MatrixEvent[] {
        const events = space.currentState.getStateEvents(EventType.SpaceChild);
        const cached = this.sortedChildren.get(space.roomId);
        if (cached?.events.length === events.length && cached.events.every((event, i) => event === events[i])) {
            return cached.sorted;
        }
        const valid = events.filter((event) => {
            const via = event.getContent().via;
            // A child event without servers to join through is a removed child.
            return event.getStateKey()?.startsWith("!") && Array.isArray(via) && via.length > 0;
        });
        const sorted = sortBy(valid, (event) =>
            getChildOrder(event.getContent().order, event.getTs(), event.getStateKey()!),
        );
        this.sortedChildren.set(space.roomId, { events, sorted });
        return sorted;
    }

    /**
     * Subscribe the channels of the active Space and of the subspaces the user has joined, and stop subscribing ones no
     * longer in it. They are read from the Spaces' state, so a Space whose state has not arrived yet adds none until
     * it does. Upgraded rooms count as their newest version, as the Space shows them. A child that has not arrived
     * yet counts as a channel until it turns out to be a Space.
     */
    private refreshSpaceChannels(): void {
        this.spaceTreeChanged = false;
        const client = this.client;
        const userId = client?.getUserId();
        const dynamicPredecessors = SettingsStore.getValue("feature_dynamic_room_predecessors");
        const channels = new Set<string>();
        // Every room the walk met, including each version of an upgraded one, so the tree is read again when one of
        // them changes.
        const tree = new Set<string>();
        const walked = new Set<string>();
        const queue = this.activeSpaceId ? [this.activeSpaceId] : [];
        let visits = 0;
        while (queue.length > 0 && channels.size < MAX_SPACE_CHANNELS && visits < MAX_SPACE_TREE_VISITS) {
            const spaceId = queue.shift()!;
            tree.add(spaceId);
            walked.add(spaceId);
            // In the Space's own order, so the same channels are kept when there are too many.
            const space = client?.getRoom(spaceId);
            for (const child of space ? this.childrenInOrder(space) : []) {
                if (channels.size >= MAX_SPACE_CHANNELS || ++visits > MAX_SPACE_TREE_VISITS) break;
                const childId = child.getStateKey()!;
                tree.add(childId);
                const versions = client?.getRoomUpgradeHistory(childId, true, dynamicPredecessors) ?? [];
                for (const version of versions) tree.add(version.roomId);
                const room = versions.at(-1) ?? client?.getRoom(childId);
                const roomId = room?.roomId ?? childId;
                if (walked.has(roomId) || channels.has(roomId)) continue;
                // A replacement nobody has seen yet is subscribed, so it can arrive, whether it is a channel or a
                // subspace. Until then the room it replaces stands in for it, as the Space shows it.
                const replacement = room?.currentState
                    .getStateEvents(EventType.RoomTombstone, "")
                    ?.getContent().replacement_room;
                if (typeof replacement === "string" && replacement.startsWith("!") && !client?.getRoom(replacement)) {
                    tree.add(replacement);
                    if (channels.size < MAX_SPACE_CHANNELS) channels.add(replacement);
                }
                if (room?.isSpaceRoom()) {
                    if (room.getMyMembership() === KnownMembership.Join) {
                        walked.add(roomId);
                        queue.push(roomId);
                    }
                    continue;
                }
                // Rooms the user has left are not shown. The SDK reports "leave" for a room it has no membership
                // for yet, so the user's own member event decides.
                const membership = userId
                    ? room?.currentState.getStateEvents(EventType.RoomMember, userId)?.getContent().membership
                    : undefined;
                if (membership === KnownMembership.Leave || membership === KnownMembership.Ban) continue;
                // Once the lists cover the whole account, they keep a joined channel up to date already.
                if (this.listsCoverAccount && room?.getMyMembership() === KnownMembership.Join) continue;
                if (channels.size < MAX_SPACE_CHANNELS) channels.add(roomId);
            }
        }
        this.spaceTree = tree;
        // Channels this device saved, but has not applied yet, are applied while the page is idle, so the Space's
        // channel list fills without waiting for the server.
        const slidingSync = this.slidingSync;
        const saved = [...channels].filter(
            (roomId) =>
                !this.savedChannelsAsked.has(roomId) && !client?.getRoom(roomId) && slidingSync?.hasSavedRoom(roomId),
        );
        for (const roomId of saved) this.savedChannelsAsked.add(roomId);
        if (saved.length > 0) void slidingSync!.restoreSavedRooms(saved, true);
        // Only the Spaces in the tree keep their order, so visiting many Spaces does not grow it.
        for (const spaceId of this.sortedChildren.keys()) {
            if (!walked.has(spaceId)) this.sortedChildren.delete(spaceId);
        }
        if (channels.size === this.spaceChannels.size && [...channels].every((id) => this.spaceChannels.has(id))) {
            return;
        }
        this.spaceChannels = channels;
        // Sent with the next batch: the channel someone opens next is urgent, and carries these along with it.
        this.scheduleFlush(false);
    }

    /** Replace discovery state with the normal subscription once encryption state is known. */
    private upgradeDiscoveredRoom(room: Room): void {
        const preparation = this.initialTimelines.get(room.roomId);
        if (preparation?.phase === "expanding" || (preparation?.phase === "initial" && preparation.needsExpansion))
            return;
        if (!this.bootstrapRooms.delete(room.roomId)) return;
        this.scheduleFlush(true);
    }

    /**
     * Retrieve all rooms on the user's account. Retrieval is gradual over time.
     * This function MUST be called BEFORE the first sync request goes out.
     * @param batchSize The number of rooms to return in each request.
     * @param gapBetweenRequestsMs The number of milliseconds to wait between requests.
     */
    private async startSpidering(
        slidingSync: SlidingSync,
        batchSize: number,
        gapBetweenRequestsMs: number,
        bootstrap = false,
    ): Promise<void> {
        // The manager has created several lists (see `sssLists` in this file), all of which will be spidered simultaneously.
        // There are multiple lists to ensure that we can populate invites/favourites/DMs sections immediately, rather than
        // potentially waiting minutes if they are all very old rooms (and hence are returned last by the server). In this
        // way, the lists are effectively priority requests. We don't actually care which room goes into which list at this
        // point, as the RoomListStore will calculate this based on the returned data.

        // copy the initial set of list names and ranges, we'll keep this map updated.
        const listToUpperBound = new Map(
            Object.keys(sssLists)
                .filter((listName) => !FIXED_LISTS.has(listName))
                .map((listName) => {
                    return [
                        listName,
                        slidingSync.getListParams(listName)?.ranges[0][1] ?? sssLists[listName].ranges[0][1],
                    ];
                }),
        );
        logger.debug("startSpidering:", listToUpperBound);

        // listen for a response from the server. ANY 200 OK will do here, as we assume that it is ACKing
        // the request change we have sent out. TODO: this may not be true if you concurrently subscribe to a room :/
        // but in that case, for spidering at least, it isn't the end of the world as request N+1 includes all indexes
        // from request N.
        const lifecycle = async (
            state: SlidingSyncState,
            _: MSC3575SlidingSyncResponse | null,
            err?: Error,
        ): Promise<void> => {
            if (state !== SlidingSyncState.Complete || err) return;
            // Complete precedes account-data extensions. Yield before expanding the background lists.
            await sleep(gapBetweenRequestsMs);
            if (this.slidingSync !== slidingSync) {
                slidingSync.off(SlidingSyncEvent.Lifecycle, lifecycle);
                return;
            }

            // Keep the next native response focused while a membership-only destination expands.
            if ([...this.initialTimelines.values()].some((preparation) => preparation.phase === "expanding")) return;

            for (const roomId of this.bootstrapRooms) {
                const room = this.client?.getRoom(roomId);
                if (!room) continue;
                this.upgradeDiscoveredRoom(room);
            }

            if (bootstrap) {
                bootstrap = false;
                for (const [name, normal] of Object.entries(sssLists)) {
                    const current = slidingSync.getListParams(name) ?? normal;
                    const upperBound = FIXED_LISTS.has(name)
                        ? normal.ranges[0][1]
                        : Math.max(current.ranges[0][1], normal.ranges[0][1]);
                    slidingSync.setList(name, {
                        ...current,
                        ranges: [[0, upperBound]],
                        timeline_limit: normal.timeline_limit,
                    });
                    if (!FIXED_LISTS.has(name)) listToUpperBound.set(name, upperBound);
                }
                return;
            }

            // for all lists with total counts > range => increase the range
            let hasSetRanges = false;
            listToUpperBound.forEach((currentUpperBound, listName) => {
                const totalCount = slidingSync.getListData(listName)?.joinedCount || 0;
                if (currentUpperBound < totalCount - 1) {
                    // increment the upper bound
                    const newUpperBound = Math.min(currentUpperBound + batchSize, totalCount - 1);
                    logger.debug(`startSpidering: ${listName} ${currentUpperBound} => ${newUpperBound}`);
                    listToUpperBound.set(listName, newUpperBound);
                    // make the next request. This will only send the request when this callback has finished, so if
                    // we set all the list ranges at once we will only send 1 new request.
                    slidingSync.setListRanges(listName, [[0, newUpperBound]]);
                    hasSetRanges = true;
                }
            });
            if (!hasSetRanges && this.bootstrapRooms.size === 0) {
                // finish spidering
                slidingSync.off(SlidingSyncEvent.Lifecycle, lifecycle);
                // The open Space's channels the lists now cover need no subscription of their own.
                this.listsCoverAccount = true;
                // Every room is known: history may now be fetched to make their counts exact.
                this.countEngine?.allowRecovery();
                this.notifyArrivals();
                if (this.activeSpaceId) this.refreshSpaceChannels();
            }
        };
        slidingSync.on(SlidingSyncEvent.Lifecycle, lifecycle);
    }

    /**
     * Set up the Sliding Sync instance; configures the end point and starts spidering.
     * The sliding sync endpoint is derived the following way:
     *   1. The user-defined sliding sync proxy URL (legacy, for backwards compatibility)
     *   2. The client `well-known` sliding sync proxy URL [declared at the unstable prefix](https://github.com/matrix-org/matrix-spec-proposals/blob/kegan/sync-v3/proposals/3575-sync.md#unstable-prefix)
     *   3. The homeserver base url (for native server support)
     * @param client The MatrixClient to use
     * @param initialRoomId Resolved room ID to prioritise on the first request; aliases must be resolved first.
     * @param prefetch Last Space and channel to load alongside the small Home lists, without selecting either.
     * @returns A working Sliding Sync or undefined
     */
    public async setup(
        client: MatrixClient,
        initialRoomId?: string,
        prefetch?: { roomId?: string; spaceId?: string },
    ): Promise<SlidingSync | undefined> {
        const slidingSync = this.configure(client, client.baseUrl, initialRoomId);
        this.roomsShownFirst = [initialRoomId, prefetch?.roomId, prefetch?.spaceId].filter(
            (roomId): roomId is string => !!roomId?.startsWith("!"),
        );
        if (initialRoomId?.startsWith("!")) {
            this.beginInitialTimeline(initialRoomId);
            // The room view takes its own lease once it opens; this keeps the destination until then.
            this.leases.prefetch(initialRoomId);
        } else if (prefetch) {
            const hinted = new Set<string>();
            if (prefetch.roomId?.startsWith("!") && prefetch.roomId !== prefetch.spaceId) {
                hinted.add(prefetch.roomId);
                this.beginInitialTimeline(prefetch.roomId);
                this.leases.prefetch(prefetch.roomId);
            }
            if (prefetch.spaceId?.startsWith("!")) {
                hinted.add(prefetch.spaceId);
                // Spaces need their child graph and metadata, without conversation history.
                this.expectedSpaces.add(prefetch.spaceId);
                this.leases.prefetch(prefetch.spaceId);
                this.activeSpaceId = prefetch.spaceId;
                this.refreshSpaceChannels();
            }
            // Saved hints may refer to rooms the account has since left. Drop absent hints
            // after the first response so they cannot keep background discovery pending.
            const onFirstResponse = (
                state: SlidingSyncState,
                response: MSC3575SlidingSyncResponse | null,
                error?: Error,
            ): void => {
                if (state !== SlidingSyncState.Complete || !response || error) return;
                slidingSync.off(SlidingSyncEvent.Lifecycle, onFirstResponse);
                if (this.slidingSync !== slidingSync) return;
                for (const roomId of hinted) {
                    if (response.rooms?.[roomId]) continue;
                    this.bootstrapRooms.delete(roomId);
                    this.expectedSpaces.delete(roomId);
                    this.leases.cancelPrefetch(roomId);
                }
                this.applySubscriptions(slidingSync);
            };
            slidingSync.on(SlidingSyncEvent.Lifecycle, onFirstResponse);
        }
        if (this.pendingActiveSpace) {
            const spaceId = this.pendingActiveSpace;
            this.pendingActiveSpace = undefined;
            this.setActiveSpace(spaceId);
        }
        // The first request must carry the destination, so apply its subscription now rather than in a batch.
        this.applySubscriptions(slidingSync);
        this.attachCache(client, slidingSync);
        logger.info("Simplified Sliding Sync activated at", client.baseUrl);
        void this.startSpidering(slidingSync, SPIDER_BATCH_SIZE, SPIDER_GAP_MS, true);
        return slidingSync;
    }

    /**
     * What to show at startup before the server answers: the rooms and account data this device saved in the
     * previous session. Passed to the SDK as `slidingSyncSnapshot` when the client starts.
     * @param client - The client being started; must be the one {@link setup} was given.
     */
    public snapshotLoader(client: MatrixClient): (() => Promise<SlidingSyncSnapshot | null>) | undefined {
        const cache = this.cache;
        if (!cache || this.client !== client) return undefined;
        // A read started early is used once; a later start reads afresh. One made for another client is let go.
        const prefetched = this.prefetched?.cache === cache ? this.prefetched.snapshot : undefined;
        if (this.prefetched && this.prefetched.cache !== cache) void this.prefetched.cache.dispose();
        this.prefetched = undefined;
        return async () => {
            const read = await (prefetched ?? cache.load());
            // Deleted meanwhile, such as by a logout in another window: nothing saved is shown.
            const snapshot = cache.isClosed ? null : read;
            // Restored rooms show the counts they had, worked out from what was saved with them.
            if (snapshot && this.client === client) this.countEngine?.useSaved(cache.restoredCounts);
            // The room and Space the app opens at start are shown before the rest.
            if (snapshot) snapshot.priorityRoomIds = [...this.roomsShownFirst];
            return snapshot;
        };
    }

    /**
     * Start reading the rooms this device saved, while the client's stores and crypto are still being opened, so
     * they are ready to show as soon as sync starts. {@link setup} then uses the same cache.
     * @param client - The client about to be set up.
     */
    public prefetchSnapshot(client: MatrixClient): void {
        const userId = client.getUserId();
        const deviceId = client.getDeviceId();
        if (!userId || !deviceId) return;
        // An earlier read nobody used is dropped; the cache in use stays.
        if (this.prefetched && this.prefetched.cache !== this.cache) void this.prefetched.cache.dispose();
        const cache = new SlidingSyncCache(userId, deviceId);
        this.prefetched = { client, cache, snapshot: cache.load() };
    }

    /** Let go of the saved rooms read before set-up, such as when the client syncs without sliding sync after all. */
    public discardPrefetchedSnapshot(): void {
        if (this.prefetched && this.prefetched.cache !== this.cache) void this.prefetched.cache.dispose();
        this.prefetched = undefined;
    }

    /** Keep what this connection learns on this device, for the next start. */
    private attachCache(client: MatrixClient, slidingSync: SlidingSync): void {
        const userId = client.getUserId();
        const deviceId = client.getDeviceId();
        const previous = this.cache;
        // An early read for this client is adopted, unless its saved data was deleted meanwhile. One for another
        // client, or a deleted one, is let go.
        let prefetched: SlidingSyncCache | undefined;
        if (this.prefetched?.client === client && !this.prefetched.cache.isClosed) {
            prefetched = this.prefetched.cache;
        } else if (this.prefetched) {
            void this.prefetched.cache.dispose();
            this.prefetched = undefined;
        }
        if (previous !== prefetched) void previous?.dispose();
        this.cache = prefetched ?? (userId && deviceId ? new SlidingSyncCache(userId, deviceId) : undefined);
        const cache = this.cache;
        if (!cache) return;

        const onRoomData = (roomId: string, data: MSC3575RoomData): void => {
            cache.observeRoomData(roomId, data);
        };
        const onAccountData = (event: MatrixEvent): void => cache.observeAccountData(event);
        const onRoomAccountData = (event: MatrixEvent, room: Room): void =>
            cache.observeRoomAccountData(room.roomId, event);
        const onReceipt = (event: MatrixEvent, room: Room): void => cache.observeReceipt(room.roomId, event);
        const countEngine = this.countEngine;
        // Hidden or closing pages may not run another task, so the write starts in this one, with the counts that
        // are ready published first so they are saved with their rooms.
        const flushNow = (): void => {
            countEngine?.finishPending();
            cache.flushNow();
        };
        const onPageHidden = (): void => {
            if (document.visibilityState === "hidden") flushNow();
        };
        const onPageHide = (): void => flushNow();
        // Account data and receipts are watched from the first Prepared state onwards. Restoring the saved
        // session announces the same events, which need not be saved again.
        let watchingClient = false;
        const watchClient = (): void => {
            if (watchingClient) return;
            watchingClient = true;
            client.on(ClientEvent.AccountData, onAccountData);
            client.on(RoomEvent.AccountData, onRoomAccountData);
            client.on(RoomEvent.Receipt, onReceipt);
        };
        const onSync = (state: SyncState): void => {
            if (state === SyncState.Prepared || state === SyncState.Syncing) watchClient();
        };
        let checking = false;
        // The saved rooms still to check; all of them until the first check.
        let unchecked: ReadonlySet<string> | undefined;
        const onComplete = (state: SlidingSyncState, _response: unknown, error?: Error): void => {
            if (checking || state !== SlidingSyncState.Complete || error) return;
            checking = true;
            const candidates = unchecked ?? new Set(cache.restoredRoomIds);
            void this.dropRoomsLeftWhileAway(client, slidingSync, cache, candidates).then((remaining) => {
                checking = false;
                unchecked = remaining;
                if (remaining.size === 0) slidingSync.off(SlidingSyncEvent.Lifecycle, onComplete);
            });
        };
        slidingSync.on(SlidingSyncEvent.RoomData, onRoomData);
        slidingSync.on(SlidingSyncEvent.Lifecycle, onComplete);
        client.on(ClientEvent.Sync, onSync);
        document.addEventListener("visibilitychange", onPageHidden);
        window.addEventListener("pagehide", onPageHide);
        // Each room's notification count ledger is saved with it, as its counts were last published.
        cache.setCountsSource((roomId) => countEngine?.save(roomId));
        countEngine?.setChangeListener((roomId) => cache.observeCounts(roomId));
        // A room changed by a response is written once the whole response is applied, receipts included.
        const onResponse = (state: SlidingSyncState, response: unknown, error?: Error): void => {
            if (state === SlidingSyncState.RequestFinished && response && !error) cache.beginResponse();
        };
        const onApplied = (): void => cache.endResponse();
        slidingSync.on(SlidingSyncEvent.Lifecycle, onResponse);
        slidingSync.on(SlidingSyncEvent.Applied, onApplied);
        this.detachCache = (): void => {
            // The last write still checks each room's counts are ready: those that are, are published first.
            countEngine?.finishPending();
            countEngine?.setChangeListener(undefined);
            slidingSync.off(SlidingSyncEvent.Lifecycle, onResponse);
            slidingSync.off(SlidingSyncEvent.Applied, onApplied);
            slidingSync.off(SlidingSyncEvent.RoomData, onRoomData);
            slidingSync.off(SlidingSyncEvent.Lifecycle, onComplete);
            client.off(ClientEvent.Sync, onSync);
            client.off(ClientEvent.AccountData, onAccountData);
            client.off(RoomEvent.AccountData, onRoomAccountData);
            client.off(RoomEvent.Receipt, onReceipt);
            document.removeEventListener("visibilitychange", onPageHidden);
            window.removeEventListener("pagehide", onPageHide);
            void cache.dispose().finally(() => cache.setCountsSource(undefined));
        };
    }

    /**
     * Treat saved rooms the user is no longer in as left: they left, were removed, or the room was forgotten while
     * this device was away. Sliding sync does not say that a room has gone, so the server's list of joined rooms is
     * asked after the first response. The rooms are shown as left, as a regular sync shows rooms the user has left,
     * and are not saved again.
     * @param candidates - The saved rooms to check.
     * @returns The rooms to check again after the next response; none once the check is over for this connection.
     */
    private async dropRoomsLeftWhileAway(
        client: MatrixClient,
        slidingSync: SlidingSync,
        cache: SlidingSyncCache,
        candidates: ReadonlySet<string>,
    ): Promise<ReadonlySet<string>> {
        // Responses are processed only once saved rooms are restored, so by now it is known whether there were any.
        if (candidates.size === 0) return candidates;
        // Data sliding sync reports while the list is fetched may be newer than the list, such as a room rejoined
        // meanwhile, or older, such as a room left meanwhile. Those rooms are checked again after the next response.
        const reported = new Set<string>();
        const onRoomData = (roomId: string): void => void reported.add(roomId);
        slidingSync.on(SlidingSyncEvent.RoomData, onRoomData);
        let joined: Set<string>;
        try {
            joined = new Set((await client.getJoinedRooms()).joined_rooms);
        } catch (error) {
            logger.warn("SlidingSync: could not check which saved rooms the user is still in", error);
            return candidates;
        } finally {
            slidingSync.off(SlidingSyncEvent.RoomData, onRoomData);
        }
        if (this.slidingSync !== slidingSync || this.client !== client) return new Set();
        const recheck = new Set<string>();
        const gone: string[] = [];
        for (const roomId of candidates) {
            if (joined.has(roomId)) continue;
            // An invite is the server's to report.
            if (client.getRoom(roomId)?.getMyMembership() === KnownMembership.Invite) continue;
            if (reported.has(roomId)) recheck.add(roomId);
            else gone.push(roomId);
        }
        if (gone.length > 0) {
            logger.info(`SlidingSync: ${gone.length} saved rooms are no longer joined`);
            for (const roomId of gone) {
                this.leftWhileAway.add(roomId);
                const room = client.getRoom(roomId);
                if (room && room.getMyMembership() !== KnownMembership.Leave)
                    room.updateMyMembership(KnownMembership.Leave);
            }
            cache.forgetRooms(gone);
            this.notifyArrivals();
        }
        return recheck;
    }

    /**
     * Check if the server "natively" supports sliding sync (with an unstable endpoint).
     * @param client The MatrixClient to use
     * @returns Whether the "native" (unstable) endpoint is supported
     */
    public async nativeSlidingSyncSupport(client: MatrixClient): Promise<boolean> {
        // Per https://github.com/matrix-org/matrix-spec-proposals/pull/3575/files#r1589542561
        // `client` can be undefined/null in tests for some reason.
        // A response that lists no unstable features at all gives undefined, which means no.
        const support = (await client?.doesServerSupportUnstableFeature("org.matrix.simplified_msc3575")) === true;
        if (support) {
            logger.log("nativeSlidingSyncSupport: org.matrix.simplified_msc3575 sliding sync advertised as unstable");
        }
        return support;
    }

    /**
     * Whether a client syncs with sliding sync: it was set up for it, rather than falling back to regular sync, such
     * as because its server offers no sliding sync.
     * @param client - The client.
     */
    public isActiveFor(client: MatrixClient | null | undefined): boolean {
        return !!client && this.client === client && this.slidingSync !== undefined;
    }

    /**
     * Ask whether a client's server offers sliding sync. The answer is kept for the settings, and on this device for
     * the next start ({@link knownServerSupport}).
     * @param client - The client.
     * @returns Whether it does, or undefined when it could not be asked, such as while offline.
     */
    public async serverOffersSlidingSync(client: MatrixClient): Promise<boolean | undefined> {
        let supported: boolean;
        try {
            supported = await this.nativeSlidingSyncSupport(client);
        } catch (error) {
            logger.warn("SlidingSync: could not ask whether the server offers sliding sync", error);
            return undefined;
        }
        SlidingSyncManager.serverSupportsSlidingSync = supported;
        try {
            localStorage.setItem(supportKey(client), String(supported));
        } catch (error) {
            // Storage is full, say. An answer that cannot be updated is dropped rather than left stale, so the next
            // start asks the server again.
            logger.warn("SlidingSync: could not keep whether the server offers sliding sync", error);
            try {
                localStorage.removeItem(supportKey(client));
            } catch {
                // Nothing more can be done.
            }
        }
        return supported;
    }

    /**
     * What a client's server last said, on this device, about offering sliding sync.
     * @param client - The client.
     * @returns Whether it did, or undefined when it has not been asked from here yet.
     */
    public knownServerSupport(client: MatrixClient): boolean | undefined {
        try {
            const known = localStorage.getItem(supportKey(client));
            return known === null ? undefined : known === "true";
        } catch {
            return undefined;
        }
    }

    /**
     * Check whether our homeserver has sliding sync support, that the endpoint is up, and
     * is a sliding sync endpoint.
     *
     * Sets static member `SlidingSyncController.serverSupportsSlidingSync`
     * @param client The MatrixClient to use
     */
    public async checkSupport(client: MatrixClient): Promise<void> {
        if (await this.nativeSlidingSyncSupport(client)) {
            SlidingSyncManager.serverSupportsSlidingSync = true;
            return;
        }
        SlidingSyncManager.serverSupportsSlidingSync = false;
    }
}
