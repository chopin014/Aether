/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "test-utils-rtl";
import { stubClient, TestSDKContext } from "test-utils";
import {
    EventType,
    MatrixEvent,
    Room,
    RoomMember,
    RoomMemberEvent,
    RoomStateEvent,
    User,
    UserEvent,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";

import MatrixClientContext from "../../contexts/MatrixClientContext";
import { SDKContext } from "../../contexts/SDKContext";
import defaultDispatcher from "../../dispatcher/dispatcher";
import SpaceStore from "../../stores/spaces/SpaceStore";
import { UPDATE_SELECTED_SPACE } from "../../stores/spaces";
import { SEPARATOR, useMemberListViewModel } from "../../components/viewmodels/memberlist/MemberListViewModel";
import { isMemberHeading, type DesktopMemberListItem } from "./desktopMemberGroups";
import { useDesktopMemberListViewModel } from "./useDesktopMemberListViewModel";

function headings(items: DesktopMemberListItem[]) {
    return items.filter(isMemberHeading).map(({ heading, count }) => [heading, count]);
}

function memberRows(items: DesktopMemberListItem[]) {
    return items.flatMap((item) => (item !== SEPARATOR && !isMemberHeading(item) && item.member ? item.member : []));
}

function setup(inSpace = false, enabled = true, loadSpace: () => Promise<boolean> = async () => false) {
    const client = stubClient();
    vi.mocked(client.hasLazyLoadMembersEnabled).mockReturnValue(false);
    const context = new TestSDKContext();
    context._client = client;
    const room = new Room("!channel:example.org", client, client.getSafeUserId());
    room.updateMyMembership(KnownMembership.Join);
    const space = new Room("!server:example.org", client, client.getSafeUserId());
    vi.mocked(client.getRoom).mockImplementation((id) =>
        id === room.roomId ? room : id === space.roomId ? space : null,
    );
    vi.spyOn(space, "loadMembersIfNeeded").mockImplementation(loadSpace);
    let selectedSpace: Room | null = inSpace ? space : null;
    const spaceStore = new SpaceStore(defaultDispatcher, context);
    context._SpaceStore = spaceStore;
    vi.spyOn(spaceStore, "activeSpaceRoom", "get").mockImplementation(() => selectedSpace);
    const isRoomInSpace = vi.spyOn(spaceStore, "isRoomInSpace").mockReturnValue(true);

    const addMember = (target: Room, name: string, level = 0, presence = "online") => {
        const member = new RoomMember(target.roomId, `@${name.toLowerCase()}:example.org`);
        member.name = name;
        member.powerLevel = level;
        member.membership = KnownMembership.Join;
        member.user = User.createUser(member.userId, client);
        member.user.presence = presence;
        target.currentState.members[member.userId] = member;
        return member;
    };
    const ada = addMember(room, "Ada", 100);
    const bob = addMember(room, "Bob", 50, "unavailable");
    const cy = addMember(room, "Cy", 0, "offline");
    const serverAda = addMember(space, "Ada", 0);
    const serverBob = addMember(space, "Bob", 100);

    const hook = renderHook(
        () => {
            const vm = useMemberListViewModel(room.roomId);
            return { vm, items: useDesktopMemberListViewModel(room.roomId, vm, enabled) };
        },
        {
            wrapper: ({ children }) => (
                <MatrixClientContext.Provider value={client}>
                    <SDKContext.Provider value={context}>{children}</SDKContext.Provider>
                </MatrixClientContext.Provider>
            ),
        },
    );
    const selectSpace = (next: Room | null) => {
        selectedSpace = next;
        spaceStore.emit(UPDATE_SELECTED_SPACE);
    };
    return {
        ...hook,
        client,
        context,
        room,
        space,
        spaceStore,
        isRoomInSpace,
        addMember,
        ada,
        bob,
        cy,
        serverAda,
        serverBob,
        selectSpace,
    };
}

describe("useDesktopMemberListViewModel", () => {
    afterEach(() => vi.restoreAllMocks());

    it("should update membership, presence, role and profile groups without duplicates or empty headings", async () => {
        const { result, client, room, ada, bob, cy, addMember } = setup();
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        expect(headings(result.current.items)).toEqual([
            ["Admin", 1],
            ["Moderator", 1],
            ["Offline", 1],
        ]);

        act(() => {
            ada.user!.presence = "offline";
            client.emit(UserEvent.Presence, undefined, ada.user!);
        });
        await waitFor(() =>
            expect(headings(result.current.items)).toEqual([
                ["Moderator", 1],
                ["Offline", 2],
            ]),
        );

        act(() => {
            bob.powerLevel = 100;
            client.emit(RoomMemberEvent.PowerLevel, new MatrixEvent({}), bob);
        });
        await waitFor(() =>
            expect(headings(result.current.items)).toEqual([
                ["Admin", 1],
                ["Offline", 2],
            ]),
        );

        act(() => {
            cy.name = "Aardvark";
            client.emit(RoomMemberEvent.Name, new MatrixEvent({}), cy, "Cy");
        });
        await waitFor(() =>
            expect(memberRows(result.current.items).map((row) => row.name)).toEqual(["Bob", "Aardvark", "Ada"]),
        );

        act(() => {
            bob.membership = KnownMembership.Leave;
            const joined = addMember(room, "Dora");
            client.emit(RoomMemberEvent.Membership, new MatrixEvent({}), bob, KnownMembership.Join);
            client.emit(RoomMemberEvent.Membership, new MatrixEvent({}), joined, KnownMembership.Leave);
        });
        await waitFor(() =>
            expect(headings(result.current.items)).toEqual([
                ["Online", 1],
                ["Offline", 2],
            ]),
        );
        expect(new Set(memberRows(result.current.items).map((row) => row.userId)).size).toBe(3);
    });

    it("should load Space roles and update when Space powers, membership or selected server change", async () => {
        const { result, client, space, serverAda, serverBob, selectSpace } = setup(true);
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        expect(space.loadMembersIfNeeded).toHaveBeenCalledTimes(1);
        expect(headings(result.current.items)).toEqual([
            ["Admin", 1],
            ["Online", 1],
            ["Offline", 1],
        ]);
        expect(memberRows(result.current.items)[0].name).toBe("Bob");
        expect(memberRows(result.current.items)[0].powerLevel).toBe(50);

        act(() => {
            serverAda.powerLevel = 100;
            serverBob.membership = KnownMembership.Leave;
            client.emit(RoomMemberEvent.PowerLevel, new MatrixEvent({}), serverAda);
            client.emit(RoomMemberEvent.Membership, new MatrixEvent({}), serverBob, KnownMembership.Join);
        });
        expect(memberRows(result.current.items)[0].name).toBe("Ada");
        expect(headings(result.current.items)).toEqual([
            ["Admin", 1],
            ["Online", 1],
            ["Offline", 1],
        ]);

        act(() => selectSpace(null));
        expect(headings(result.current.items)).toEqual([
            ["Admin", 1],
            ["Moderator", 1],
            ["Offline", 1],
        ]);
    });

    it("should refresh headings when lazily loaded Space roles arrive", async () => {
        const pending = Promise.withResolvers<boolean>();
        const { result, serverAda, serverBob } = setup(true, true, () => pending.promise);
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        expect(memberRows(result.current.items)[0].name).toBe("Bob");
        serverAda.powerLevel = 100;
        serverBob.powerLevel = 0;
        await act(async () => pending.resolve(true));
        expect(memberRows(result.current.items)[0].name).toBe("Ada");
    });

    it("should retain neutral server roles if loading Space membership fails", async () => {
        const pending = Promise.withResolvers<boolean>();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const { result, space, client } = setup(true, true, () => pending.promise);
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        act(() => {
            space.currentState.members = {};
            client.emit(RoomStateEvent.Update, space.currentState);
        });
        await act(async () => pending.reject(new Error("Fixture membership failure")));
        expect(warn).toHaveBeenCalledWith("Unable to load Space roles for the member list", expect.any(Error));
        expect(headings(result.current.items)).toEqual([
            ["Online", 2],
            ["Offline", 1],
        ]);
    });

    it("should use room roles for channels outside the selected Space", async () => {
        const { result, client, spaceStore, space, isRoomInSpace } = setup(true);
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        act(() => {
            isRoomInSpace.mockReturnValue(false);
            spaceStore.emit(space.roomId);
            client.emit(
                RoomStateEvent.Events,
                new MatrixEvent({ type: EventType.SpaceChild, room_id: space.roomId }),
                space.currentState,
                null,
            );
        });
        expect(headings(result.current.items)).toEqual([
            ["Admin", 1],
            ["Moderator", 1],
            ["Offline", 1],
        ]);
    });

    it("should retain search on live updates, update matching profiles and count only filtered rows", async () => {
        const { result, client, ada, bob, room, addMember } = setup();
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        act(() => result.current.vm.search("Ada"));
        await waitFor(() => expect(result.current.vm.memberCount).toBe(1));
        expect(headings(result.current.items)).toEqual([["Admin", 1]]);

        act(() => {
            ada.user!.presence = "offline";
            client.emit(UserEvent.Presence, undefined, ada.user!);
        });
        await waitFor(() => expect(headings(result.current.items)).toEqual([["Offline", 1]]));

        act(() => {
            bob.name = "Ada too";
            client.emit(RoomMemberEvent.Name, new MatrixEvent({}), bob, "Bob");
            const joined = addMember(room, "Adaline");
            client.emit(RoomMemberEvent.Membership, new MatrixEvent({}), joined, KnownMembership.Leave);
        });
        await waitFor(() => expect(result.current.vm.memberCount).toBe(3));
        expect(headings(result.current.items)).toEqual([
            ["Moderator", 1],
            ["Online", 1],
            ["Offline", 1],
        ]);
        expect(memberRows(result.current.items).map((row) => row.name)).toEqual(["Ada too", "Adaline", "Ada"]);

        act(() => result.current.vm.search("no matches"));
        await waitFor(() => expect(result.current.vm.memberCount).toBe(0));
        expect(result.current.items).toEqual([]);
    });

    it("should discard an older search response that completes after a newer query", async () => {
        const { result, context } = setup();
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        const original = context.memberListStore.loadMemberList.bind(context.memberListStore);
        const pending = Promise.withResolvers<Awaited<ReturnType<typeof original>>>();
        const spy = vi
            .spyOn(context.memberListStore, "loadMemberList")
            .mockImplementation((id, query) => (query === "Ada" ? pending.promise : original(id, query)));
        act(() => result.current.vm.search("Ada"));
        await waitFor(() => expect(spy).toHaveBeenCalledWith("!channel:example.org", "Ada"));
        act(() => result.current.vm.search("Bob"));
        await waitFor(() => expect(memberRows(result.current.items).map((row) => row.name)).toEqual(["Bob"]));
        await act(async () => pending.resolve(await original("!channel:example.org", "Ada")));
        expect(memberRows(result.current.items).map((row) => row.name)).toEqual(["Bob"]);
    });

    it("should leave non-desktop rows untouched and avoid loading Space members", async () => {
        const { result, space } = setup(true, false);
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        expect(result.current.items).toBe(result.current.vm.members);
        expect(space.loadMembersIfNeeded).not.toHaveBeenCalled();
    });

    it("should remove listeners and ignore in-flight member loads after unmount", async () => {
        const { result, context, client, spaceStore, unmount } = setup(true);
        const off = vi.spyOn(client, "off");
        await waitFor(() => expect(result.current.vm.isLoading).toBe(false));
        const pending = Promise.withResolvers<{ joined: RoomMember[]; invited: RoomMember[] }>();
        const spy = vi.spyOn(context.memberListStore, "loadMemberList").mockReturnValue(pending.promise);
        act(() => result.current.vm.search("Ada"));
        await waitFor(() => expect(spy).toHaveBeenCalled());
        unmount();
        expect(spaceStore.listenerCount(UPDATE_SELECTED_SPACE)).toBe(0);
        expect(off).toHaveBeenCalledWith(UserEvent.Presence, expect.any(Function));
        await act(async () => pending.resolve({ joined: [], invited: [] }));
    });
});
