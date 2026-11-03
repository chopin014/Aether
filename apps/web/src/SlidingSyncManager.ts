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

import { type MatrixClient, ClientEvent, EventType, type Room } from "matrix-js-sdk/src/matrix";
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
} from "matrix-js-sdk/src/sliding-sync";
import { logger } from "matrix-js-sdk/src/logger";
import { sleep } from "matrix-js-sdk/src/utils";

import { JitsiCallMemberEventType } from "./call-types";

// how long to long poll for
const SLIDING_SYNC_TIMEOUT_MS = 20 * 1000;

// Keep enough recent events to open a listed room before its focused subscription returns.
// A single event is often a hidden membership update in large public rooms.
const LIST_TIMELINE_LIMIT = 20;

// Calls and widgets can outlive the recent timeline; request their current state explicitly.
const CALL_STATE = [
    [EventType.GroupCallPrefix, MSC3575_WILDCARD],
    [EventType.GroupCallMemberPrefix, MSC3575_WILDCARD],
    [EventType.RTCSlot, MSC3575_WILDCARD],
    ["im.vector.modular.widgets", MSC3575_WILDCARD],
    [JitsiCallMemberEventType, MSC3575_WILDCARD],
];

// The state events we will get for every single room/space/old room/etc
// This list is only augmented when a direct room subscription is made. (e.g you view a room)
const REQUIRED_STATE_LIST = [
    ...CALL_STATE,
    [EventType.RoomJoinRules, ""], // the public icon on the room list
    [EventType.RoomAvatar, ""], // any room avatar
    [EventType.RoomCanonicalAlias, ""], // for room name calculations
    [EventType.RoomTombstone, ""], // lets JS SDK hide rooms which are dead
    [EventType.RoomEncryption, ""], // lets rooms be configured for E2EE correctly
    [EventType.RoomCreate, ""], // for isSpaceRoom checks
    [EventType.SpaceChild, MSC3575_WILDCARD], // all space children
    [EventType.SpaceParent, MSC3575_WILDCARD], // all space parents
    [EventType.RoomMember, MSC3575_STATE_KEY_ME], // lets the client calculate that we are in fact in the room
    [EventType.RoomMember, MSC3575_STATE_KEY_LAZY], // names and avatars for cached timeline senders
];

// the things to fetch when a user clicks on a room
const DEFAULT_ROOM_SUBSCRIPTION_INFO = {
    timeline_limit: 50,
    // missing required_state which will change depending on the kind of room
    include_old_rooms: {
        timeline_limit: 0,
        required_state: REQUIRED_STATE_LIST,
    },
};
// lazy load room members so rooms like Matrix HQ don't take forever to load
const UNENCRYPTED_SUBSCRIPTION_NAME = "unencrypted";
const UNENCRYPTED_SUBSCRIPTION = {
    required_state: [
        ...CALL_STATE,
        [EventType.RoomMember, MSC3575_STATE_KEY_ME], // except for m.room.members, get our own membership
        [EventType.RoomMember, MSC3575_STATE_KEY_LAZY], // ...and lazy load the rest.
    ],
    ...DEFAULT_ROOM_SUBSCRIPTION_INFO,
};

// we need all the room members in encrypted rooms because we need to know which users to encrypt
// messages for.
const ENCRYPTED_SUBSCRIPTION = {
    required_state: [
        [MSC3575_WILDCARD, MSC3575_WILDCARD], // all events
    ],
    ...DEFAULT_ROOM_SUBSCRIPTION_INFO,
};

// Fetch enough state to discover encryption and render the destination before loading its full roster.
const BOOTSTRAP_SUBSCRIPTION_NAME = "bootstrap";
const ENCRYPTED_SUBSCRIPTION_NAME = "encrypted";
const EXPANDED_BOOTSTRAP_SUBSCRIPTION_NAME = "bootstrap-expanded";
const BOOTSTRAP_SUBSCRIPTION = {
    timeline_limit: 50,
    required_state: [
        ...REQUIRED_STATE_LIST,
        [EventType.RoomName, ""],
        [EventType.RoomTopic, ""],
        [EventType.RoomPowerLevels, ""],
        [EventType.RoomHistoryVisibility, ""],
    ],
};

// the complete set of lists made in SSS. The manager will spider all of these lists depending
// on the count for each one.
const sssLists: Record<string, MSC3575List> = {
    spaces: {
        ranges: [[0, 10]],
        timeline_limit: 0, // we don't care about the most recent message for spaces
        required_state: REQUIRED_STATE_LIST,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: REQUIRED_STATE_LIST,
        },
        filters: {
            room_types: ["m.space"],
        },
    },
    invites: {
        ranges: [[0, 10]],
        timeline_limit: 1, // most recent message display
        required_state: REQUIRED_STATE_LIST,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: REQUIRED_STATE_LIST,
        },
        filters: {
            is_invite: true,
        },
    },
    favourites: {
        ranges: [[0, 10]],
        timeline_limit: LIST_TIMELINE_LIMIT, // recent events for immediate room entry
        required_state: REQUIRED_STATE_LIST,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: REQUIRED_STATE_LIST,
        },
        filters: {
            tags: ["m.favourite"],
        },
    },
    dms: {
        ranges: [[0, 10]],
        timeline_limit: LIST_TIMELINE_LIMIT, // recent events for immediate room entry
        required_state: REQUIRED_STATE_LIST,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: REQUIRED_STATE_LIST,
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
        timeline_limit: LIST_TIMELINE_LIMIT, // recent events for immediate room entry
        required_state: REQUIRED_STATE_LIST,
        include_old_rooms: {
            timeline_limit: 0,
            required_state: REQUIRED_STATE_LIST,
        },
    },
};

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
 */
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

    private configureDefer = Promise.withResolvers<void>();

    public static get instance(): SlidingSyncManager {
        return SlidingSyncManager.internalInstance;
    }

    private configure(client: MatrixClient, proxyUrl: string, initialRoomId?: string): SlidingSync {
        this.cancelInitialPreparations?.();
        this.initialTimelines.clear();
        for (const settle of this.roomWaiters) settle();
        this.client = client;
        this.bootstrapRooms.clear();
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
        this.slidingSync.addCustomSubscription(UNENCRYPTED_SUBSCRIPTION_NAME, UNENCRYPTED_SUBSCRIPTION);
        this.slidingSync.addCustomSubscription(ENCRYPTED_SUBSCRIPTION_NAME, ENCRYPTED_SUBSCRIPTION);
        this.slidingSync.addCustomSubscription(BOOTSTRAP_SUBSCRIPTION_NAME, BOOTSTRAP_SUBSCRIPTION);
        this.slidingSync.addCustomSubscription(EXPANDED_BOOTSTRAP_SUBSCRIPTION_NAME, {
            ...BOOTSTRAP_SUBSCRIPTION,
            timeline_limit: 100,
        });
        this.trackInitialTimelines(this.slidingSync);
        const ownedSync = this.slidingSync;
        // SlidingSync has no stopped event. Settle waits before our owned instance stops.
        const stop = ownedSync.stop.bind(ownedSync);
        ownedSync.stop = (): void => {
            if (this.slidingSync === ownedSync) this.cancelInitialPreparations?.();
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
            if (room) this.upgradeDiscoveredRoom(this.slidingSync, room);
            else this.slidingSync.useCustomSubscription(roomId, BOOTSTRAP_SUBSCRIPTION_NAME);
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
                    slidingSync.useCustomSubscription(roomId, EXPANDED_BOOTSTRAP_SUBSCRIPTION_NAME);
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
     * be displayed, so it should have more state loaded.
     * @param roomId The room to set visible
     */
    public async setRoomVisible(roomId: string): Promise<void> {
        await this.configureDefer.promise;
        const client = this.client!;
        const slidingSync = this.slidingSync!;
        const subscriptions = slidingSync.getRoomSubscriptions();
        if (subscriptions.has(roomId)) return;

        subscriptions.add(roomId);

        const room = client.getRoom(roomId);
        // Unknown rooms first fetch encryption metadata and lazy members, then upgrade once discovered.
        let shouldLazyLoad = false;
        if (room) {
            // do not lazy load encrypted rooms as we need the entire member list.
            shouldLazyLoad =
                !room.hasEncryptionStateEvent() && !(await client.getCrypto()?.isEncryptionEnabledInRoom(roomId));
        }
        if (this.client !== client || this.slidingSync !== slidingSync) return;
        logger.log("SlidingSync setRoomVisible:", roomId, "shouldLazyLoad:", shouldLazyLoad);
        if (!room) {
            this.beginInitialTimeline(roomId);
            slidingSync.useCustomSubscription(roomId, BOOTSTRAP_SUBSCRIPTION_NAME);
        } else if (shouldLazyLoad) {
            // lazy load this room
            slidingSync.useCustomSubscription(roomId, UNENCRYPTED_SUBSCRIPTION_NAME);
        }
        slidingSync.modifyRoomSubscriptions(subscriptions);
        if (room) {
            return; // we have data already for this room, show immediately e.g it's in a list
        }
        // wait until we know about this room. This may take a little while.
        return new Promise((resolve) => {
            const settle = (): void => {
                client.off(ClientEvent.Room, waitForRoom);
                this.roomWaiters.delete(settle);
                resolve();
            };
            const waitForRoom = (r: Room): void => {
                if (this.client !== client || this.slidingSync !== slidingSync) {
                    settle();
                    return;
                }
                if (r.roomId !== roomId) return;
                this.upgradeDiscoveredRoom(slidingSync, r);
                settle();
            };
            this.roomWaiters.add(settle);
            client.on(ClientEvent.Room, waitForRoom);
        });
    }

    /** Replace discovery state with the normal subscription once encryption state is known. */
    private upgradeDiscoveredRoom(slidingSync: SlidingSync, room: Room): void {
        const preparation = this.initialTimelines.get(room.roomId);
        if (preparation?.phase === "expanding" || (preparation?.phase === "initial" && preparation.needsExpansion))
            return;
        if (!this.bootstrapRooms.delete(room.roomId)) return;
        slidingSync.useCustomSubscription(
            room.roomId,
            room.hasEncryptionStateEvent() ? ENCRYPTED_SUBSCRIPTION_NAME : UNENCRYPTED_SUBSCRIPTION_NAME,
        );
        slidingSync.modifyRoomSubscriptions(slidingSync.getRoomSubscriptions());
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
            Object.keys(sssLists).map((listName) => {
                return [listName, slidingSync.getListParams(listName)?.ranges[0][1] ?? sssLists[listName].ranges[0][1]];
            }),
        );
        console.log("startSpidering:", listToUpperBound);

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
                this.upgradeDiscoveredRoom(slidingSync, room);
            }

            if (bootstrap) {
                bootstrap = false;
                for (const [name, normal] of Object.entries(sssLists)) {
                    const current = slidingSync.getListParams(name) ?? normal;
                    const upperBound = Math.max(current.ranges[0][1], normal.ranges[0][1]);
                    slidingSync.setList(name, {
                        ...current,
                        ranges: [[0, upperBound]],
                        timeline_limit: normal.timeline_limit,
                    });
                    listToUpperBound.set(name, upperBound);
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
                    console.log(`startSpidering: ${listName} ${currentUpperBound} => ${newUpperBound}`);
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
        if (initialRoomId?.startsWith("!")) {
            this.beginInitialTimeline(initialRoomId);
            slidingSync.useCustomSubscription(initialRoomId, BOOTSTRAP_SUBSCRIPTION_NAME);
            slidingSync.modifyRoomSubscriptions(new Set([initialRoomId]));
        } else if (prefetch) {
            const subscriptions = new Set<string>();
            if (prefetch.roomId?.startsWith("!") && prefetch.roomId !== prefetch.spaceId) {
                subscriptions.add(prefetch.roomId);
                this.beginInitialTimeline(prefetch.roomId);
                slidingSync.useCustomSubscription(prefetch.roomId, BOOTSTRAP_SUBSCRIPTION_NAME);
            }
            if (prefetch.spaceId?.startsWith("!")) {
                subscriptions.add(prefetch.spaceId);
                // Spaces need their child graph and metadata, without conversation history.
                const spaceSubscription = "space-bootstrap";
                slidingSync.addCustomSubscription(spaceSubscription, { ...BOOTSTRAP_SUBSCRIPTION, timeline_limit: 0 });
                slidingSync.useCustomSubscription(prefetch.spaceId, spaceSubscription);
            }
            slidingSync.modifyRoomSubscriptions(subscriptions);
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
                const current = slidingSync.getRoomSubscriptions();
                let removed = false;
                for (const roomId of subscriptions) {
                    if (response.rooms?.[roomId]) continue;
                    this.bootstrapRooms.delete(roomId);
                    removed = current.delete(roomId) || removed;
                }
                if (removed) slidingSync.modifyRoomSubscriptions(current);
            };
            slidingSync.on(SlidingSyncEvent.Lifecycle, onFirstResponse);
        }
        logger.info("Simplified Sliding Sync activated at", client.baseUrl);
        void this.startSpidering(slidingSync, 50, 50, true); // 50 rooms at a time, 50ms apart
        return slidingSync;
    }

    /**
     * Check if the server "natively" supports sliding sync (with an unstable endpoint).
     * @param client The MatrixClient to use
     * @returns Whether the "native" (unstable) endpoint is supported
     */
    public async nativeSlidingSyncSupport(client: MatrixClient): Promise<boolean> {
        // Per https://github.com/matrix-org/matrix-spec-proposals/pull/3575/files#r1589542561
        // `client` can be undefined/null in tests for some reason.
        const support = await client?.doesServerSupportUnstableFeature("org.matrix.simplified_msc3575");
        if (support) {
            logger.log("nativeSlidingSyncSupport: org.matrix.simplified_msc3575 sliding sync advertised as unstable");
        }
        return support;
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
