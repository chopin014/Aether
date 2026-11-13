/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { EventType } from "matrix-js-sdk/src/matrix";
import { MSC3575_STATE_KEY_ME, MSC3575_WILDCARD } from "matrix-js-sdk/src/sliding-sync";

import {
    CATALOG_STATE,
    ENCRYPTED_SUBSCRIPTION,
    NAMED_SUBSCRIPTIONS,
    NO_LABS,
    ROOM_STATE,
    RoomSubscriptionName,
    roomStateProfiles,
    SPACE_LIST_STATE,
} from "./roomStateProfiles";

describe("roomStateProfiles", () => {
    it("asks for every listed room's power levels, so @room mentions highlight and notify there", () => {
        expect(CATALOG_STATE).toContainEqual([EventType.RoomPowerLevels, ""]);
    });

    it("lists every Space with its soundboard as well as the catalog, each asked for once", () => {
        expect(SPACE_LIST_STATE).toEqual(expect.arrayContaining(CATALOG_STATE));
        expect(SPACE_LIST_STATE).toContainEqual(["io.aether.soundboard.sound", "*"]);
        const keys = SPACE_LIST_STATE.map(([type, stateKey]) => `${type}|${stateKey}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("asks for no older rooms, which simplified sliding sync does not serve", () => {
        for (const subscription of NAMED_SUBSCRIPTIONS.values()) {
            expect(subscription).not.toHaveProperty("include_old_rooms");
        }
    });

    it("asks for each piece of an open room's state once", () => {
        const keys = ROOM_STATE.map(([type, stateKey]) => `${type}|${stateKey}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("asks for the state read about rooms nobody has opened", () => {
        // Only state that is asked for arrives: the server sends nothing else, and the timeline never adds to it.
        expect(CATALOG_STATE).toEqual(
            expect.arrayContaining([
                ["im.vector.web.settings", ""],
                ["org.matrix.room.preview_urls", ""],
                ["io.element.functional_members", ""],
                [EventType.RoomThirdPartyInvite, MSC3575_WILDCARD],
                [EventType.RoomPredecessor, ""],
                ["io.element.widgets.layout", ""],
                [EventType.RoomPinnedEvents, ""],
                [EventType.RoomServerAcl, ""],
            ]),
        );
        const keys = CATALOG_STATE.map(([type, stateKey]) => `${type}|${stateKey}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("asks for the user's own live location shares in every room, and everyone's in an open room", () => {
        // A share is sent under the stable name or, by older clients, the unstable one.
        for (const type of ["m.beacon_info", "org.matrix.msc3672.beacon_info"]) {
            // This device sends its location to its own shares until their state says they stopped.
            expect(CATALOG_STATE).toContainEqual([type, MSC3575_STATE_KEY_ME]);
            expect(SPACE_LIST_STATE).toContainEqual([type, MSC3575_STATE_KEY_ME]);
            // The timeline shows a share as live from the room's state.
            expect(ROOM_STATE).toContainEqual([type, MSC3575_WILDCARD]);
            expect(CATALOG_STATE).not.toContainEqual([type, MSC3575_WILDCARD]);
        }
    });

    it("asks for an open room's bridges, shown in its settings", () => {
        expect(ROOM_STATE).toContainEqual(["uk.half-shot.bridge", MSC3575_WILDCARD]);
    });

    it("never asks for every event type, except for encrypted rooms", () => {
        // Synapse answers a wildcard event type with all of a room's state, every member of a large room included.
        for (const [name, subscription] of NAMED_SUBSCRIPTIONS) {
            if (subscription === ENCRYPTED_SUBSCRIPTION) continue;
            expect({ name, types: (subscription.required_state ?? []).map(([type]) => type) }).toEqual({
                name,
                types: expect.not.arrayContaining([MSC3575_WILDCARD]),
            });
        }
        expect(SPACE_LIST_STATE.map(([type]) => type)).not.toContain(MSC3575_WILDCARD);
    });

    describe("with labs features", () => {
        const RETENTION = [
            ["m.room.retention", ""],
            ["org.matrix.msc1763.retention", ""],
        ];

        it("asks for nothing more while none is on", () => {
            const profiles = roomStateProfiles(NO_LABS);
            expect(profiles.catalog).toBe(CATALOG_STATE);
            expect(profiles.spaceList).toBe(SPACE_LIST_STATE);
            expect(profiles.named).toBe(NAMED_SUBSCRIPTIONS);
            expect(CATALOG_STATE).not.toEqual(expect.arrayContaining([RETENTION[0]]));
        });

        it("asks every listed room for its retention policy while message retention is on", () => {
            const profiles = roomStateProfiles({ retention: true });
            expect(profiles.catalog).toEqual([...CATALOG_STATE, ...RETENTION]);
            expect(profiles.spaceList).toEqual([...SPACE_LIST_STATE, ...RETENTION]);
            for (const [name, subscription] of profiles.named) {
                if (name === RoomSubscriptionName.Encrypted) {
                    // It asks for all of a room's state already.
                    expect(subscription).toBe(ENCRYPTED_SUBSCRIPTION);
                    continue;
                }
                const named = NAMED_SUBSCRIPTIONS.get(name)!;
                expect({ name, subscription }).toEqual({
                    name,
                    subscription: { ...named, required_state: [...named.required_state!, ...RETENTION] },
                });
            }
            // The defaults are left as they are.
            expect(CATALOG_STATE).not.toEqual(expect.arrayContaining([RETENTION[0]]));
        });
    });
});
