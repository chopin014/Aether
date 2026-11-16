/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ClientEvent,
    EventType,
    KnownMembership,
    type MatrixClient,
    MatrixError,
    MatrixEvent,
    Room,
    RoomEvent,
    RoomStateEvent,
    RoomType,
    SyncState,
} from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { KNOWN_CHANNELS_ACCOUNT_DATA_TYPE, NewChannelJoiner } from "./NewChannelJoiner";
import { SPACE_CHILD_JOINABLE_FIELD } from "./joinableChild";
import { listJoinableChannels, type ServerChannel } from "../../utils/servers/serverChannels";
import SettingsStore from "../../settings/SettingsStore";

vi.mock("../../utils/servers/serverChannels", () => ({ listJoinableChannels: vi.fn() }));

const ME = "@userId:matrix.org";
const ADMIN = "@admin:example.org";
const SPACE = "!space:example.org";

describe("NewChannelJoiner", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let space: Room;
    let joiner: NewChannelJoiner;
    let settings: Record<string, boolean>;
    let ts: number;

    function makeRoom(roomId: string, membership?: KnownMembership, type?: string): Room {
        const room = new Room(roomId, client, ME);
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomCreate,
                state_key: "",
                room_id: roomId,
                sender: ADMIN,
                event_id: `$create${roomId}`,
                origin_server_ts: 1,
                content: type ? { type } : {},
            }),
        ]);
        if (membership) {
            room.updateMyMembership(membership);
            room.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomMember,
                    state_key: ME,
                    room_id: roomId,
                    sender: ME,
                    event_id: `$member${roomId}`,
                    origin_server_ts: 100,
                    content: { membership },
                }),
            ]);
        }
        rooms.set(roomId, room);
        return room;
    }

    /** Add a room to the Space the way a sync does, telling the client about it. */
    function addChild(roomId: string, content: Record<string, unknown> = {}, sender = ADMIN): MatrixEvent {
        const event = new MatrixEvent({
            type: EventType.SpaceChild,
            state_key: roomId,
            room_id: SPACE,
            sender,
            event_id: `$child${roomId}${ts}`,
            origin_server_ts: ts++,
            content: { via: ["example.org"], ...content },
        });
        space.currentState.setStateEvents([event]);
        client.emit(RoomStateEvent.Events, event, space.currentState, null);
        return event;
    }

    function setKnown(content: Record<string, unknown>): void {
        space.addAccountData([new MatrixEvent({ type: KNOWN_CHANNELS_ACCOUNT_DATA_TYPE, content })]);
    }

    const sync = (state = SyncState.Syncing): void => {
        client.emit(ClientEvent.Sync, state, null);
    };

    const joined = (): string[] => vi.mocked(client.joinRoom).mock.calls.map(([roomId]) => roomId);

    const channel = (roomId: string): ServerChannel => ({
        roomId,
        name: roomId,
        kind: "text",
        memberCount: 1,
        suggested: false,
        via: ["example.org"],
    });

    beforeEach(() => {
        ts = 1000;
        rooms = new Map();
        client = createTestClient();
        vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
        vi.mocked(client.getRooms).mockImplementation(() => [...rooms.values()]);
        vi.mocked(client.joinRoom).mockImplementation(async (roomId) => ({ roomId }) as Room);
        vi.mocked(client.setRoomAccountData).mockResolvedValue({});
        vi.mocked(listJoinableChannels).mockResolvedValue([]);
        settings = { "feature_desktop_shell": true, "Spaces.joinAllChannels": true };
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name: string) => settings[name]);
        space = makeRoom(SPACE, KnownMembership.Join, RoomType.Space);
        joiner = new NewChannelJoiner();
        joiner.start(client);
    });

    afterEach(() => {
        joiner.stop();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("joins a channel Aether made the moment it is added, without asking the server about it", async () => {
        addChild("!general:example.org");
        sync(SyncState.Prepared);
        expect(client.setRoomAccountData).toHaveBeenCalledWith(SPACE, KNOWN_CHANNELS_ACCOUNT_DATA_TYPE, {
            v: 1,
            since: 1000,
            rooms: ["!general:example.org"],
        });

        addChild("!voice:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(client.joinRoom).toHaveBeenCalledWith("!voice:example.org", { viaServers: ["example.org"] });
        expect(listJoinableChannels).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(client.setRoomAccountData).toHaveBeenLastCalledWith(SPACE, KNOWN_CHANNELS_ACCOUNT_DATA_TYPE, {
                v: 1,
                since: 1000,
                rooms: ["!general:example.org", "!voice:example.org"],
            }),
        );
    });

    it("joins none of the channels a server already has when it is first seen", () => {
        addChild("!a:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        addChild("!b:example.org");
        sync(SyncState.Prepared);
        sync();
        expect(client.joinRoom).not.toHaveBeenCalled();
    });

    it("looks up a channel another client added, and joins it only if the user can", async () => {
        sync(SyncState.Prepared);
        vi.mocked(listJoinableChannels).mockResolvedValue([channel("!open:example.org")]);
        addChild("!open:example.org");
        addChild("!closed:example.org");
        sync();
        await vi.waitFor(() => expect(joined()).toEqual(["!open:example.org"]));
        expect(listJoinableChannels).toHaveBeenCalledTimes(1);
        expect(listJoinableChannels).toHaveBeenCalledWith(client, SPACE);
    });

    it("leaves alone a channel Aether marks as closed to the server's members", () => {
        sync(SyncState.Prepared);
        addChild("!private:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: false });
        sync();
        expect(client.joinRoom).not.toHaveBeenCalled();
        expect(listJoinableChannels).not.toHaveBeenCalled();
    });

    it("never joins a channel the user left, is in, is invited to or added themselves", () => {
        sync(SyncState.Prepared);
        makeRoom("!left:example.org", KnownMembership.Leave);
        makeRoom("!in:example.org", KnownMembership.Join);
        makeRoom("!invited:example.org", KnownMembership.Invite);
        makeRoom("!banned:example.org", KnownMembership.Ban);
        const hint = { [SPACE_CHILD_JOINABLE_FIELD]: true };
        addChild("!left:example.org", hint);
        addChild("!in:example.org", hint);
        addChild("!invited:example.org", hint);
        addChild("!banned:example.org", hint);
        addChild("!mine:example.org", hint, ME);
        // A room the client only previews reads as left, but the user was never in it.
        makeRoom("!previewed:example.org");
        addChild("!previewed:example.org", hint);
        sync();
        expect(joined()).toEqual(["!previewed:example.org"]);
    });

    it("joins each channel once, so a channel left after it was joined stays left", async () => {
        sync(SyncState.Prepared);
        addChild("!new:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(joined()).toEqual(["!new:example.org"]);

        // The user left it, and the client has since forgotten the room, as it does on its next start. An admin
        // editing the child later, such as to reorder it, is not a new channel.
        addChild("!new:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true, order: "a" });
        sync();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(joined()).toEqual(["!new:example.org"]);
    });

    it("skips the channels another device of the user was already offered", () => {
        setKnown({ v: 1, since: 500, rooms: ["!seen:example.org"] });
        sync(SyncState.Prepared);
        addChild("!seen:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        addChild("!unseen:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(joined()).toEqual(["!unseen:example.org"]);
    });

    it("joins channels added while the app was closed, but none from before the server was first seen", () => {
        setKnown({ v: 1, since: 2000, rooms: [] });
        addChild("!old:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        ts = 3000;
        addChild("!while-away:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync(SyncState.Prepared);
        expect(joined()).toEqual(["!while-away:example.org"]);
    });

    it("joins nothing when the user turned automatic joins off, nor later when they turn it back on", () => {
        sync(SyncState.Prepared);
        settings["Spaces.joinAllChannels"] = false;
        addChild("!new:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        settings["Spaces.joinAllChannels"] = true;
        sync();
        addChild("!other:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(joined()).toEqual(["!other:example.org"]);
    });

    it("leaves a server the user is joining again to the join flow", () => {
        setKnown({ v: 1, since: 500, rooms: [] });
        space.updateMyMembership(KnownMembership.Leave);
        joiner.expectJoin(SPACE);
        sync(SyncState.Prepared);

        addChild("!added-while-gone:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        space.updateMyMembership(KnownMembership.Join);
        client.emit(RoomEvent.MyMembership, space, KnownMembership.Join, KnownMembership.Leave);
        sync();
        expect(client.joinRoom).not.toHaveBeenCalled();

        addChild("!added-later:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(joined()).toEqual(["!added-later:example.org"]);
    });

    it("treats nothing from before the user joined a server as new, even if it arrives later", () => {
        sync(SyncState.Prepared);
        ts = 50; // the user's membership is from 100
        addChild("!old:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(client.joinRoom).not.toHaveBeenCalled();
    });

    it("tries a join again after a passing failure, but not after a refusal", async () => {
        vi.useFakeTimers();
        sync(SyncState.Prepared);
        vi.mocked(client.joinRoom).mockImplementation(async (roomId) => {
            if (roomId === "!refused:example.org") throw new MatrixError({ errcode: "M_FORBIDDEN" }, 403);
            if (vi.mocked(client.joinRoom).mock.calls.filter(([id]) => id === roomId).length < 3) {
                throw new MatrixError({ errcode: "M_UNKNOWN" }, 502);
            }
            return { roomId } as Room;
        });
        addChild("!busy:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        addChild("!refused:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        await vi.runAllTimersAsync();
        expect(joined().filter((id) => id === "!busy:example.org")).toHaveLength(3);
        expect(joined().filter((id) => id === "!refused:example.org")).toHaveLength(1);
    });

    it("joins nothing when an unusual number of channels arrive at once", () => {
        sync(SyncState.Prepared);
        for (let i = 0; i < 51; i++) addChild(`!c${i}:example.org`, { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(client.joinRoom).not.toHaveBeenCalled();
    });

    it("joins a few channels at a time", async () => {
        sync(SyncState.Prepared);
        const pending: Array<() => void> = [];
        vi.mocked(client.joinRoom).mockImplementation(
            (roomId) => new Promise((resolve) => pending.push(() => resolve({ roomId } as Room))),
        );
        for (let i = 0; i < 6; i++) addChild(`!c${i}:example.org`, { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        await vi.waitFor(() => expect(client.joinRoom).toHaveBeenCalledTimes(4));
        pending.splice(0).forEach((resolve) => resolve());
        await vi.waitFor(() => expect(client.joinRoom).toHaveBeenCalledTimes(6));
    });

    it("does nothing outside the desktop shell, and stops with the client", () => {
        settings["feature_desktop_shell"] = false;
        sync(SyncState.Prepared);
        expect(client.setRoomAccountData).not.toHaveBeenCalled();

        settings["feature_desktop_shell"] = true;
        joiner.stop();
        addChild("!new:example.org", { [SPACE_CHILD_JOINABLE_FIELD]: true });
        sync();
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
        expect(client.joinRoom).not.toHaveBeenCalled();
    });

    it("ignores rooms that are not servers, and servers the user is not in", () => {
        makeRoom("!plain:example.org", KnownMembership.Join);
        makeRoom("!invited-space:example.org", KnownMembership.Invite, RoomType.Space);
        sync(SyncState.Prepared);
        expect(client.setRoomAccountData).toHaveBeenCalledTimes(1);
        expect(client.setRoomAccountData).toHaveBeenCalledWith(SPACE, KNOWN_CHANNELS_ACCOUNT_DATA_TYPE, {
            v: 1,
            since: 100,
            rooms: [],
        });
    });
});
