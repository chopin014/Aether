/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, waitFor } from "test-utils-rtl";
import {
    MatrixEvent,
    type MatrixClient,
    PendingEventOrdering,
    Room,
    RoomMember,
    User,
    UserEvent,
} from "matrix-js-sdk/src/matrix";
import React from "react";
import { getMockClientWithEventEmitter, stubClient } from "test-utils";

import { MatrixClientPeg } from "../../../MatrixClientPeg";
import DMRoomMap from "../../../utils/DMRoomMap";
import WithPresenceIndicator, { Presence, usePresenceDetails } from "./WithPresenceIndicator";
import * as useMergedPresenceModule from "../../../presence/useMergedPresence";
import * as useSettings from "../../../hooks/useSettings";
import { isPresenceEnabled } from "../../../utils/presence";
import { getJoinedNonFunctionalMembers } from "../../../utils/room/getJoinedNonFunctionalMembers";

vi.mock("../../../utils/presence");

vi.mock("../../../utils/room/getJoinedNonFunctionalMembers", () => ({
    getJoinedNonFunctionalMembers: vi.fn().mockReturnValue([1, 2]),
}));

describe("WithPresenceIndicator", () => {
    const ROOM_ID = "roomId";

    let mockClient: MatrixClient;
    let room: Room;

    function renderComponent() {
        return render(
            <WithPresenceIndicator room={room}>
                <span />
            </WithPresenceIndicator>,
        );
    }

    beforeEach(() => {
        stubClient();
        mockClient = vi.mocked(MatrixClientPeg.safeGet());
        room = new Room(ROOM_ID, mockClient, mockClient.getUserId() ?? "", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });

        const dmRoomMap = {
            getUserIdForRoomId: vi.fn(),
        } as unknown as DMRoomMap;
        vi.spyOn(DMRoomMap, "shared").mockReturnValue(dmRoomMap);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders only child if presence is disabled", async () => {
        vi.mocked(isPresenceEnabled).mockReturnValue(false);
        const { container } = renderComponent();

        expect(container.children).toHaveLength(1);
        expect(container.children[0].tagName).toBe("SPAN");
    });

    it.each([
        ["online", "Online"],
        ["offline", "Offline"],
        ["unavailable", "Away"],
    ])("renders presence indicator with tooltip for DM rooms", async (presenceStr, renderedStr) => {
        vi.mocked(isPresenceEnabled).mockReturnValue(true);
        const DM_USER_ID = "@bob:foo.bar";
        const dmRoomMap = {
            getUserIdForRoomId: () => {
                return DM_USER_ID;
            },
        } as unknown as DMRoomMap;
        vi.spyOn(DMRoomMap, "shared").mockReturnValue(dmRoomMap);
        room.getMember = vi.fn((userId) => {
            const member = new RoomMember(room.roomId, userId);
            member.user = new User(userId);
            member.user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: presenceStr } }));
            return member;
        });

        const { asFragment } = renderComponent();

        expect(asFragment()).toMatchSnapshot();
    });
});

describe("usePresenceDetails without the desktop shell", () => {
    const ROOM_ID = "roomId";
    const DM_USER_ID = "@bob:foo.bar";

    let mockClient: ReturnType<typeof getMockClientWithEventEmitter>;
    let room: Room;
    let member: RoomMember;
    let user: User;

    beforeEach(() => {
        mockClient = getMockClientWithEventEmitter({
            getUserId: vi.fn().mockReturnValue("@alice:foo.bar"),
            getUser: vi.fn().mockReturnValue(null),
            store: { getPendingEvents: vi.fn().mockResolvedValue([]) },
        });
        room = new Room(ROOM_ID, mockClient as unknown as MatrixClient, mockClient.getUserId() ?? "");

        vi.mocked(isPresenceEnabled).mockReturnValue(true);
        vi.mocked(getJoinedNonFunctionalMembers).mockReturnValue([1, 2] as any);

        user = new User(DM_USER_ID);
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
        member = new RoomMember(ROOM_ID, DM_USER_ID);
        member.user = user;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns null when presence is disabled", () => {
        vi.mocked(isPresenceEnabled).mockReturnValue(false);
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBeNull();
    });

    it("returns null when room does not have exactly 2 members", () => {
        vi.mocked(getJoinedNonFunctionalMembers).mockReturnValue([1] as any);
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBeNull();
    });

    it("returns no indicator for the SDK's offline default without a received event", () => {
        delete user.events.presence;
        user.presence = "offline";
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBeNull();
    });

    it("returns null when member is null", () => {
        const { result } = renderHook(() => usePresenceDetails(room, null));
        expect(result.current.presence).toBeNull();
    });

    it.each([
        ["online", Presence.Online],
        ["offline", Presence.Offline],
        ["unavailable", Presence.Away],
        ["busy", Presence.Busy],
    ])("returns correct presence for user with '%s' presence state", (presenceStr, expectedPresence) => {
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: presenceStr } }));
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBe(expectedPresence);
    });

    it("preserves explicit offline presence even if currentlyActive is stale", () => {
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "offline" } }));
        user.currentlyActive = true;
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBe(Presence.Offline);
    });

    it("updates when UserEvent.Presence fires on member.user", async () => {
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBe(Presence.Online);

        act(() => {
            user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "offline" } }));
            user.emit(UserEvent.Presence, null as any, user);
        });

        await waitFor(() => expect(result.current.presence).toBe(Presence.Offline));
    });

    it("does not infer Online from an activity flag while explicitly offline", async () => {
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "offline" } }));
        user.currentlyActive = false;
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBe(Presence.Offline);

        act(() => {
            user.currentlyActive = true;
            user.emit(UserEvent.CurrentlyActive, null as any, user);
        });

        await waitFor(() => expect(result.current.presence).toBe(Presence.Offline));
    });

    it("returns correct presence when member.user is not linked but client has user data", () => {
        member.user = undefined;
        vi.mocked(mockClient.getUser).mockImplementation((userId) => (userId === DM_USER_ID ? user : null));

        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBe("online");
    });

    it("updates via client-level UserEvent.Presence when member.user is not yet linked", async () => {
        member.user = undefined;
        vi.mocked(mockClient.getUser).mockImplementation((userId) => (userId === DM_USER_ID ? user : null));
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));

        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBe(Presence.Online);

        act(() => {
            user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "offline" } }));
            mockClient.emit(UserEvent.Presence, null as any, user);
        });

        await waitFor(() => expect(result.current.presence).toBe(Presence.Offline));
    });

    it("does not update when client emits UserEvent.Presence for a different user", async () => {
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBe(Presence.Online);

        act(() => {
            const otherUser = new User("@other:foo.bar");
            otherUser.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "offline" } }));
            mockClient.emit(UserEvent.Presence, null as any, otherUser);
        });

        expect(result.current.presence).toBe(Presence.Online);
    });
});

describe("usePresenceDetails with the desktop shell", () => {
    const DM_USER_ID = "@bob:foo.bar";
    let room: Room;
    let member: RoomMember;

    beforeEach(() => {
        const client = getMockClientWithEventEmitter({
            getUserId: vi.fn().mockReturnValue("@alice:foo.bar"),
            getUser: vi.fn().mockReturnValue(null),
            store: { getPendingEvents: vi.fn().mockResolvedValue([]) },
        });
        room = new Room("roomId", client as unknown as MatrixClient, "@alice:foo.bar");
        member = new RoomMember("roomId", DM_USER_ID);
        vi.mocked(isPresenceEnabled).mockReturnValue(false);
        vi.mocked(getJoinedNonFunctionalMembers).mockReturnValue([1, 2] as any);
        vi.spyOn(useSettings, "useFeatureEnabled").mockReturnValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("uses seen activity with its own wording even where server presence is disabled", () => {
        vi.spyOn(useMergedPresenceModule, "useMergedPresence").mockReturnValue({
            state: "online",
            source: "activity",
            label: "Active now",
        });
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current).toEqual({ presence: Presence.Online, label: "Active now" });
    });

    it("shows nothing when nothing is known", () => {
        vi.spyOn(useMergedPresenceModule, "useMergedPresence").mockReturnValue(null);
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current).toEqual({ presence: null });
    });

    it("shows nothing outside one-to-one rooms", () => {
        vi.mocked(getJoinedNonFunctionalMembers).mockReturnValue([1, 2, 3] as any);
        vi.spyOn(useMergedPresenceModule, "useMergedPresence").mockReturnValue({ state: "online", source: "aether" });
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current.presence).toBeNull();
    });

    it("ignores the merged status when the flag is off", () => {
        vi.spyOn(useSettings, "useFeatureEnabled").mockReturnValue(false);
        vi.spyOn(useMergedPresenceModule, "useMergedPresence").mockReturnValue({ state: "online", source: "aether" });
        const { result } = renderHook(() => usePresenceDetails(room, member));
        expect(result.current).toEqual({ presence: null });
    });
});
