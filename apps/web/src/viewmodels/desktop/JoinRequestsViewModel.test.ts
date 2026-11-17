/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient, Room, type RoomMember, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { JoinRequestsViewModel } from "./JoinRequestsViewModel";
import * as joinRequests from "../../utils/servers/joinRequests";

function knocker(userId: string, name: string, ts: number, reason?: string): RoomMember {
    return {
        userId,
        rawDisplayName: name,
        getMxcAvatarUrl: () => undefined,
        events: { member: { getTs: () => ts, getContent: () => ({ membership: "knock", reason }) } },
    } as unknown as RoomMember;
}

describe("JoinRequestsViewModel", () => {
    let client: MatrixClient;
    let space: Room;
    let pending: RoomMember[];

    beforeEach(() => {
        client = stubClient();
        space = new Room("!server:example.org", client, client.getSafeUserId());
        pending = [
            knocker("@dave:example.org", "Dave", 200),
            knocker("@carol:example.org", "Carol", 100, "  Bob sent me the link "),
        ];
        vi.spyOn(joinRequests, "pendingJoinRequests").mockImplementation(() => [...pending]);
        vi.spyOn(joinRequests, "canDeclineJoinRequests").mockReturnValue(true);
    });

    afterEach(() => vi.restoreAllMocks());

    it("lists the requests oldest first, with their message", () => {
        const vm = new JoinRequestsViewModel({ space });
        expect(vm.getSnapshot()).toEqual({
            requests: [
                {
                    userId: "@carol:example.org",
                    name: "Carol",
                    avatarUrl: undefined,
                    reason: "Bob sent me the link",
                },
                { userId: "@dave:example.org", name: "Dave", avatarUrl: undefined, reason: undefined },
            ],
            canDecline: true,
            expanded: true,
            busyIds: [],
        });
    });

    it("follows new requests and answers from other members", () => {
        const vm = new JoinRequestsViewModel({ space });
        pending = [pending[0]];
        space.emit(RoomStateEvent.Update, space.currentState);
        expect(vm.getSnapshot().requests.map((request) => request.userId)).toEqual(["@dave:example.org"]);

        vm.dispose();
        pending = [];
        space.emit(RoomStateEvent.Update, space.currentState);
        expect(vm.getSnapshot().requests).toHaveLength(1);
    });

    it("lets someone in by inviting them", async () => {
        const vm = new JoinRequestsViewModel({ space });
        let finish!: () => void;
        vi.mocked(client.invite).mockReturnValue(new Promise((resolve) => (finish = () => resolve({}))));

        const answering = vm.approve("@carol:example.org");
        expect(vm.getSnapshot().busyIds).toEqual(["@carol:example.org"]);
        // A second click while the first is on its way does nothing.
        await vm.approve("@carol:example.org");
        finish();
        await answering;

        expect(client.invite).toHaveBeenCalledTimes(1);
        expect(client.invite).toHaveBeenCalledWith("!server:example.org", "@carol:example.org");
        expect(vm.getSnapshot().busyIds).toEqual([]);
    });

    it("turns a request down by removing it", async () => {
        const vm = new JoinRequestsViewModel({ space });
        await vm.decline("@dave:example.org");
        expect(client.kick).toHaveBeenCalledWith("!server:example.org", "@dave:example.org");
    });

    it("says when an answer fails, and clears that on the next try", async () => {
        const vm = new JoinRequestsViewModel({ space });
        vi.mocked(client.invite).mockRejectedValueOnce(new Error("offline"));
        await vm.approve("@carol:example.org");
        expect(vm.getSnapshot().error).toBe("That didn't work. Try again.");
        expect(vm.getSnapshot().busyIds).toEqual([]);

        await vm.approve("@carol:example.org");
        expect(vm.getSnapshot().error).toBeUndefined();
    });

    it("opens and closes the list", () => {
        const vm = new JoinRequestsViewModel({ space });
        vm.toggle();
        expect(vm.getSnapshot().expanded).toBe(false);
        vm.toggle();
        expect(vm.getSnapshot().expanded).toBe(true);
    });
});
