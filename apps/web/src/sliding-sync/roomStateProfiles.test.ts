/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { EventType } from "matrix-js-sdk/src/matrix";

import { CATALOG_STATE, NAMED_SUBSCRIPTIONS, ROOM_STATE } from "./roomStateProfiles";

describe("roomStateProfiles", () => {
    it("asks for every listed room's power levels, so @room mentions highlight and notify there", () => {
        expect(CATALOG_STATE).toContainEqual([EventType.RoomPowerLevels, ""]);
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
});
