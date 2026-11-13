// @vitest-environment happy-dom
/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, EventType, MatrixEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { Mjolnir } from "./Mjolnir";
import { ALL_RULE_TYPES } from "./BanList";
import SettingsStore from "../settings/SettingsStore";
import { SlidingSyncManager } from "../SlidingSyncManager";

describe("Mjolnir", () => {
    let held: Map<string, number>;
    let client: MatrixClient;

    beforeEach(() => {
        client = stubClient();
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

    it("reads a list's rules once its room is stored, when they arrived with the room", () => {
        // The client tells of a new room's state before it stores the room, so the lists cannot read it then.
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "mjolnirRooms" ? ["!list:example.org"] : undefined) as unknown as typeof SettingsStore.getValue);
        vi.mocked(client.getRoom).mockReturnValue(null);
        const mjolnir = new Mjolnir();
        mjolnir.setup();
        expect(mjolnir.isUserBanned("@spammer:example.org")).toBe(false);

        const room = new Room("!list:example.org", client, client.getSafeUserId());
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.PolicyRuleUser,
                state_key: "rule-1",
                sender: "@moderator:example.org",
                room_id: room.roomId,
                event_id: "$rule",
                content: { entity: "@spammer:example.org", recommendation: "m.ban", reason: "spam" },
            }),
        ]);
        vi.mocked(client.getRoom).mockImplementation((roomId) => (roomId === room.roomId ? room : null));
        client.emit(ClientEvent.Room, room);

        expect(mjolnir.isUserBanned("@spammer:example.org")).toBe(true);
        mjolnir.stop();
    });
});
