/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type MatrixClient, MatrixEvent, Room, RoomType } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { createTestClient } from "test-utils";

import { LINK_GRACE_MS, OTHERS_GRACE_MS, SpaceChildRepair } from "./SpaceChildRepair";

const ME = "@me:example.org";
const CREATOR = "@creator:example.org";
const STRANGER = "@stranger:example.org";
const SPACE = "!space:example.org";
const CHANNEL = "!channel:example.org";
const NOW = 1_800_000_000_000;

const sdkClient = createTestClient();

function state(roomId: string, type: string, stateKey: string, content: object, sender = CREATOR, ts = 0): MatrixEvent {
    return new MatrixEvent({ type, state_key: stateKey, room_id: roomId, sender, content, origin_server_ts: ts });
}

function room(roomId: string, events: MatrixEvent[], membership: string = KnownMembership.Join): Room {
    const r = new Room(roomId, sdkClient, ME);
    r.currentState.setStateEvents(events);
    vi.spyOn(r, "getMyMembership").mockReturnValue(membership);
    return r;
}

/** A Space where `CREATOR` and `ME` may add children, holding the given extra state. */
function space(extra: MatrixEvent[] = [], users: Record<string, number> = { [CREATOR]: 50, [ME]: 50 }): Room {
    return room(SPACE, [
        state(SPACE, EventType.RoomCreate, "", { type: RoomType.Space }),
        state(SPACE, EventType.RoomPowerLevels, "", { state_default: 50, users }),
        ...extra,
    ]);
}

/** A channel made at `madeAt` that names the Space as its parent. */
function channel(
    madeAt = NOW - OTHERS_GRACE_MS - 1,
    parent: object = { canonical: true, via: ["example.org"] },
    parentSender = CREATOR,
): Room {
    return room(CHANNEL, [
        state(CHANNEL, EventType.RoomCreate, "", {}, CREATOR, madeAt),
        state(CHANNEL, EventType.SpaceParent, SPACE, parent, parentSender, madeAt),
    ]);
}

function client(rooms: Room[], userId = ME): MatrixClient & { sendStateEvent: ReturnType<typeof vi.fn> } {
    return {
        getSafeUserId: () => userId,
        getDomain: () => "example.org",
        getRooms: () => rooms,
        getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
        sendStateEvent: vi.fn().mockResolvedValue({ event_id: "$x" }),
    } as unknown as MatrixClient & { sendStateEvent: ReturnType<typeof vi.fn> };
}

describe("SpaceChildRepair", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("links a channel whose Space never got its child event", () => {
        const cli = client([space(), channel()]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).toHaveBeenCalledExactlyOnceWith(
            SPACE,
            EventType.SpaceChild,
            { via: ["example.org"], suggested: false },
            CHANNEL,
        );
    });

    it("leaves a channel an admin removed from the Space", () => {
        const removed = state(SPACE, EventType.SpaceChild, CHANNEL, {});
        const cli = client([space([removed]), channel()]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("leaves a channel the Space already lists", () => {
        const listed = state(SPACE, EventType.SpaceChild, CHANNEL, { via: ["example.org"] });
        const cli = client([space([listed]), channel()]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("ignores a parent set by someone who may not add children to the Space", () => {
        const cli = client([space(), channel(undefined, undefined, STRANGER)]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("does nothing when this user may not add children to the Space", () => {
        const cli = client([space([], { [CREATOR]: 50 }), channel()]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("ignores a parent that is not canonical", () => {
        const cli = client([space(), channel(undefined, { via: ["example.org"] })]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("ignores a channel this user has not joined", () => {
        const left = channel();
        vi.mocked(left.getMyMembership).mockReturnValue(KnownMembership.Leave);
        const cli = client([space(), left]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("ignores a Space that was replaced by a newer one", () => {
        const cli = client([
            space([state(SPACE, EventType.RoomTombstone, "", { replacement_room: "!new" })]),
            channel(),
        ]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("counts the creator of a room version 12 Space, whom the power levels do not list", () => {
        const v12 = room(SPACE, [
            state(SPACE, EventType.RoomCreate, "", { type: RoomType.Space, room_version: "12" }, ME),
            state(SPACE, EventType.RoomPowerLevels, "", { state_default: 50, users: { [CREATOR]: 50 } }, ME),
        ]);
        const cli = client([v12, channel()]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).toHaveBeenCalledOnce();
    });

    it("lets the creation finish before the member who set the parent links it", () => {
        const cli = client([space(), channel(NOW - 1000)], CREATOR);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
        vi.advanceTimersByTime(LINK_GRACE_MS);
        expect(cli.sendStateEvent).toHaveBeenCalledOnce();
    });

    it("rechecks when the wait is over, and sends nothing if the link arrived meanwhile", () => {
        const s = space();
        const cli = client([s, channel(NOW - 1000)], CREATOR);
        new SpaceChildRepair(cli).checkAll();
        s.currentState.setStateEvents([state(SPACE, EventType.SpaceChild, CHANNEL, { via: ["example.org"] })]);
        vi.advanceTimersByTime(LINK_GRACE_MS);
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });

    it("gives the member who set the parent a day before others link it", () => {
        const cli = client([space(), channel(NOW - LINK_GRACE_MS - 1)]);
        new SpaceChildRepair(cli).checkAll();
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
        vi.advanceTimersByTime(OTHERS_GRACE_MS);
        expect(cli.sendStateEvent).toHaveBeenCalledOnce();
    });

    it("sends a link once per session, even when the send fails", async () => {
        const cli = client([space(), channel()]);
        cli.sendStateEvent.mockRejectedValue(new Error("forbidden"));
        const repair = new SpaceChildRepair(cli);
        repair.checkAll();
        await Promise.resolve();
        repair.checkAll();
        expect(cli.sendStateEvent).toHaveBeenCalledOnce();
    });

    it("cancels pending checks when stopped", () => {
        const cli = client([space(), channel(NOW - 1000)], CREATOR);
        const repair = new SpaceChildRepair(cli);
        repair.checkAll();
        repair.stop();
        vi.advanceTimersByTime(LINK_GRACE_MS);
        expect(cli.sendStateEvent).not.toHaveBeenCalled();
    });
});
