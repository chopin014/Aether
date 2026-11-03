/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type Room, type RoomMember } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";

import SettingsStore from "../settings/SettingsStore";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import SdkConfig from "../SdkConfig";

// Regex applied to filter our punctuation in member names before applying sort, to fuzzy it a little
// matches all ASCII punctuation: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
const SORT_REGEX = /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+/g;

/**
 * A class for storing application state for MemberList.
 */
export class MemberListStore {
    // cache of Display Name -> name to sort based on. This strips out special symbols like @.
    private readonly sortNames = new Map<string, string>();
    // Room identity keeps membership caches separate across sessions and room replacements.
    private readonly loadedRooms = new WeakSet<Room>();
    private readonly loadingRooms = new WeakMap<Room, Promise<void>>();

    private collator?: Intl.Collator;

    public constructor(private readonly stores: SDKContextClass) {}

    /**
     * Load the member list. Call this whenever the list may have changed.
     * @param roomId The room to load the member list in
     * @param searchQuery Optional search query to filter the list.
     * @returns A list of filtered and sorted room members, grouped by membership.
     */
    public async loadMemberList(
        roomId: string,
        searchQuery?: string,
    ): Promise<Record<"joined" | "invited", RoomMember[]>> {
        if (!this.stores.client) {
            return {
                joined: [],
                invited: [],
            };
        }
        const language = SettingsStore.getValue("language");
        this.collator = new Intl.Collator(language, { sensitivity: "base", ignorePunctuation: false });
        const members = await this.loadMembers(roomId);
        // Filter then sort as it's more efficient than sorting tons of members we will just filter out later.
        // Also sort each group, as there's no point comparing invited/joined users when they aren't in the same list!
        const membersByMembership = this.filterMembers(members, searchQuery);
        const showPresence = this.isPresenceEnabled();
        const compare = (a: RoomMember, b: RoomMember): number => this.sortMembers(a, b, showPresence);
        membersByMembership.joined.sort(compare);
        membersByMembership.invited.sort(compare);
        return {
            joined: membersByMembership.joined,
            invited: membersByMembership.invited,
        };
    }

    /**
     * Hydrate a room's complete membership without filtering or sorting it.
     * All roster consumers share the same in-flight request and SDK import.
     */
    public async ensureMembersLoaded(roomId: string): Promise<void> {
        const room = this.stores.client?.getRoom(roomId);
        if (!room) return;
        let loading = this.loadingRooms.get(room);
        if (!loading) {
            loading = this.loadMembersIfNeeded(room);
            this.loadingRooms.set(room, loading);
        }
        try {
            await loading;
        } finally {
            if (this.loadingRooms.get(room) === loading) this.loadingRooms.delete(room);
        }
    }

    private async loadMembers(roomId: string): Promise<Array<RoomMember>> {
        const room = this.stores.client!.getRoom(roomId);
        if (!room) return [];
        try {
            await this.ensureMembersLoaded(roomId);
        } catch (error) {
            // Keep known members usable while a later refresh retries the complete roster.
            logger.warn("Unable to load the complete member list", error);
        }
        return this.loadMembersInRoom(room);
    }

    private async loadMembersIfNeeded(room: Room): Promise<void> {
        const roomId = room.roomId;
        if (this.loadedRooms.has(room) || !(await this.isLazyLoadingEnabled(roomId))) return;
        // lazy loading is enabled. There are two kinds of lazy loading:
        // - With storage: most members are in indexedDB, we just need a small delta via /members.
        //   Valid for normal sync in normal windows.
        // - Without storage: nothing in indexedDB, we need to load all via /members. Valid for
        //   Sliding Sync and incognito windows (non-Sliding Sync).
        if (!this.isLazyMemberStorageEnabled()) {
            // pull straight from the server. Don't use a since token as we don't have earlier deltas
            // accumulated.
            room.currentState.markOutOfBandMembersStarted();
            try {
                const response = await this.stores.client!.members(roomId, undefined, KnownMembership.Leave);
                const memberEvents = response.chunk.map(this.stores.client!.getEventMapper());
                room.currentState.setOutOfBandMembers(memberEvents);
            } catch (error) {
                room.currentState.markOutOfBandMembersFailed();
                throw error;
            }
        } else {
            // load using traditional lazy loading
            await room.loadMembersIfNeeded();
        }
        // remember that we have loaded the members so we don't hit /members all the time. We
        // will forget this on refresh which is fine as we only store the data in-memory.
        this.loadedRooms.add(room);
    }

    private loadMembersInRoom(room: Room): Array<RoomMember> {
        const allMembers = Object.values(room.currentState.members);
        allMembers.forEach((member) => {
            // work around a race where you might have a room member object
            // before the user object exists. This may or may not cause
            // https://github.com/vector-im/vector-web/issues/186
            if (!member.user) {
                member.user = this.stores.client!.getUser(member.userId) || undefined;
            }
            // XXX: this user may have no lastPresenceTs value!
            // the right solution here is to fix the race rather than leave it as 0
        });
        return allMembers;
    }

    /**
     * Check if this room should be lazy loaded. Lazy loading means fetching the member list in
     * a delayed or incremental fashion. It means the `Room` object doesn't have all the members.
     * @param roomId The room to check if lazy loading is enabled
     * @returns True if enabled
     */
    private async isLazyLoadingEnabled(roomId: string): Promise<boolean> {
        if (SettingsStore.getValue("feature_simplified_sliding_sync")) {
            // only unencrypted rooms use lazy loading
            return !(await this.stores.client?.getCrypto()?.isEncryptionEnabledInRoom(roomId));
        }
        return this.stores.client!.hasLazyLoadMembersEnabled();
    }

    /**
     * Check if lazy member storage is supported.
     * @returns True if there is storage for lazy loading members
     */
    private isLazyMemberStorageEnabled(): boolean {
        if (SettingsStore.getValue("feature_simplified_sliding_sync")) {
            return false;
        }
        return this.stores.client!.hasLazyLoadMembersEnabled();
    }

    public isPresenceEnabled(): boolean {
        if (!this.stores.client) {
            return true;
        }
        const enablePresenceByHsUrl = SdkConfig.get("enable_presence_by_hs_url");
        return enablePresenceByHsUrl?.[this.stores.client.baseUrl] ?? true;
    }

    /**
     * Filter out members based on an optional search query. Groups by membership state.
     * @param members The list of members to filter.
     * @param query The textual query to filter based on.
     * @returns An object with a list of joined and invited users respectively.
     */
    private filterMembers(members: Array<RoomMember>, query?: string): Record<"joined" | "invited", RoomMember[]> {
        const result: Record<"joined" | "invited", RoomMember[]> = {
            joined: [],
            invited: [],
        };
        members.forEach((m) => {
            if (m.membership !== KnownMembership.Join && m.membership !== KnownMembership.Invite) {
                return; // bail early for left/banned users
            }
            if (query) {
                query = query.toLowerCase();
                const matchesName = m.name.toLowerCase().includes(query);
                const matchesId = m.userId.toLowerCase().includes(query);
                if (!matchesName && !matchesId) {
                    return;
                }
            }
            switch (m.membership) {
                case KnownMembership.Join:
                    result.joined.push(m);
                    break;
                case KnownMembership.Invite:
                    result.invited.push(m);
                    break;
            }
        });
        return result;
    }

    /**
     * Sort algorithm for room members.
     * @param memberA
     * @param memberB
     * @returns Negative if A comes before B, 0 if A and B are equivalent, Positive is A comes after B.
     */
    private sortMembers(memberA: RoomMember, memberB: RoomMember, showPresence: boolean): number {
        // order by presence, with "active now" first.
        // ...and then by power level
        // ...and then by last active
        // ...and then alphabetically.
        // We could tiebreak instead by "last recently spoken in this room" if we wanted to.

        const userA = memberA.user;
        const userB = memberB.user;

        if (!userA && !userB) return 0;
        if (userA && !userB) return -1;
        if (!userA && userB) return 1;

        // First by presence
        if (showPresence) {
            const convertPresence = (p: string): string => (p === "unavailable" ? "online" : p);
            const presenceIndex = (p: string): number => {
                const order = ["active", "online", "offline"];
                const idx = order.indexOf(convertPresence(p));
                return idx === -1 ? order.length : idx; // unknown states at the end
            };

            const idxA = presenceIndex(userA!.currentlyActive ? "active" : userA!.presence);
            const idxB = presenceIndex(userB!.currentlyActive ? "active" : userB!.presence);
            if (idxA !== idxB) {
                return idxA - idxB;
            }
        }

        // Second by power level
        if (memberA.powerLevel !== memberB.powerLevel) {
            return memberB.powerLevel - memberA.powerLevel;
        }

        // Third by last active
        if (showPresence && userA!.getLastActiveTs() !== userB!.getLastActiveTs()) {
            return userB!.getLastActiveTs() - userA!.getLastActiveTs();
        }

        // Fourth by name (alphabetical)
        return this.collator!.compare(this.canonicalisedName(memberA.name), this.canonicalisedName(memberB.name));
    }

    /**
     * Calculate the canonicalised name for the input name.
     * @param name The member display name
     * @returns The name to sort on
     */
    private canonicalisedName(name: string): string {
        let result = this.sortNames.get(name);
        if (result) {
            return result;
        }
        result = (name[0] === "@" ? name.slice(1) : name).replace(SORT_REGEX, "");
        this.sortNames.set(name, result);
        return result;
    }
}
