// @vitest-environment happy-dom
/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubClient } from "test-utils";

import { Mjolnir } from "./Mjolnir";
import { ALL_RULE_TYPES } from "./BanList";
import SettingsStore from "../settings/SettingsStore";
import { SlidingSyncManager } from "../SlidingSyncManager";

describe("Mjolnir", () => {
    let held: Map<string, number>;

    beforeEach(() => {
        stubClient();
        held = new Map();
        vi.spyOn(SlidingSyncManager.instance, "demandRoomState").mockImplementation((roomId) => {
            held.set(roomId, (held.get(roomId) ?? 0) + 1);
            let released = false;
            return {
                roomId,
                isReady: () => true,
                whenReady: () => Promise.resolve(),
                release: () => {
                    if (released) return;
                    released = true;
                    held.set(roomId, held.get(roomId)! - 1);
                    if (held.get(roomId) === 0) held.delete(roomId);
                },
            };
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps each ban list room's rules asked of sliding sync, whether or not anyone opens it", () => {
        // Under sliding sync a room has only the state its subscriptions name, so no rule would arrive otherwise.
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "mjolnirRooms"
                ? ["!a:example.org", "!b:example.org"]
                : undefined) as unknown as typeof SettingsStore.getValue);
        const mjolnir = new Mjolnir();
        mjolnir.setup();
        expect(SlidingSyncManager.instance.demandRoomState).toHaveBeenCalledWith(
            "!a:example.org",
            ALL_RULE_TYPES.map((type) => ({ type })),
        );
        expect([...held.keys()]).toEqual(["!a:example.org", "!b:example.org"]);

        // Following a different set of lists keeps the shared one asked for, without asking again.
        const onListsChanged = (mjolnir as unknown as { onListsChanged: (...args: unknown[]) => void }).onListsChanged;
        onListsChanged("mjolnirRooms", null, null, ["!b:example.org", "!c:example.org"]);
        expect(held).toEqual(
            new Map([
                ["!b:example.org", 1],
                ["!c:example.org", 1],
            ]),
        );
        expect(SlidingSyncManager.instance.demandRoomState).toHaveBeenCalledTimes(3);

        mjolnir.stop();
        expect(held.size).toBe(0);
    });
});
