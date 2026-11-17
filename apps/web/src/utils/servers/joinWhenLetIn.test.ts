/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnownMembership, type MatrixClient, type Room, RoomEvent } from "matrix-js-sdk/src/matrix";

import { joinWhenLetIn } from "./joinWhenLetIn";
import { onServerJoined } from "./joinServer";

vi.mock("./joinServer", () => ({ onServerJoined: vi.fn() }));

function fakeClient(): MatrixClient {
    return Object.assign(new EventEmitter(), { joinRoom: vi.fn().mockResolvedValue({}) }) as unknown as MatrixClient;
}

const room = { roomId: "!server:example.org" } as Room;

describe("joinWhenLetIn", () => {
    afterEach(() => vi.clearAllMocks());

    it("joins, and joins the server's channels, once a request to join is answered with an invite", async () => {
        const client = fakeClient();
        joinWhenLetIn(client);

        client.emit(RoomEvent.MyMembership, room, KnownMembership.Invite, KnownMembership.Knock);

        await vi.waitFor(() => expect(onServerJoined).toHaveBeenCalledWith(client, "!server:example.org"));
        expect(client.joinRoom).toHaveBeenCalledWith("!server:example.org", { acceptSharedHistory: true });
    });

    it("leaves ordinary invites for the user to accept", () => {
        const client = fakeClient();
        joinWhenLetIn(client);

        client.emit(RoomEvent.MyMembership, room, KnownMembership.Invite, undefined);
        client.emit(RoomEvent.MyMembership, room, KnownMembership.Invite, KnownMembership.Leave);
        client.emit(RoomEvent.MyMembership, room, KnownMembership.Leave, KnownMembership.Knock);

        expect(client.joinRoom).not.toHaveBeenCalled();
    });

    it("listens once per client", async () => {
        const client = fakeClient();
        joinWhenLetIn(client);
        joinWhenLetIn(client);

        client.emit(RoomEvent.MyMembership, room, KnownMembership.Invite, KnownMembership.Knock);

        await vi.waitFor(() => expect(onServerJoined).toHaveBeenCalled());
        expect(client.joinRoom).toHaveBeenCalledTimes(1);
    });

    it("keeps the invite when joining fails", async () => {
        const client = fakeClient();
        vi.mocked(client.joinRoom).mockRejectedValueOnce(new Error("offline"));
        joinWhenLetIn(client);

        client.emit(RoomEvent.MyMembership, room, KnownMembership.Invite, KnownMembership.Knock);

        await vi.waitFor(() => expect(client.joinRoom).toHaveBeenCalled());
        expect(onServerJoined).not.toHaveBeenCalled();
    });
});
