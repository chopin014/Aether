/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
    EventType,
    MatrixEvent,
    Room,
    RoomMember,
    User,
    UserEvent,
    ClientEvent,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopProfileViewModel, type DesktopProfileViewModelProps } from "./DesktopProfileViewModel";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { RightPanelPhases } from "../../stores/right-panel/RightPanelStorePhases";
import { startDmOnFirstMessage } from "../../utils/direct-messages";
import { findDMRoom } from "../../utils/dm/findDMRoom";
import { verifyUser } from "../../verification";
import {
    confirmAndIgnoreUser,
    unignoreUser,
} from "../../components/viewmodels/right_panel/user_info/UserInfoIgnoreButtonViewModel";
import SettingsStore from "../../settings/SettingsStore";

const { copy } = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("@element-hq/element-web-shared-utils", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    copyPlainTextToClipboard: copy,
}));
vi.mock("../../utils/direct-messages", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    startDmOnFirstMessage: vi.fn(),
}));
vi.mock("../../utils/dm/findDMRoom", () => ({ findDMRoom: vi.fn() }));
vi.mock("../../verification", () => ({ verifyUser: vi.fn() }));
vi.mock("../../components/viewmodels/right_panel/user_info/UserInfoIgnoreButtonViewModel", () => ({
    confirmAndIgnoreUser: vi.fn(),
    unignoreUser: vi.fn(),
}));
vi.mock("../../components/views/rooms/SendMessageComposer", () => ({ EDITOR_STATE_STORAGE_PREFIX: "mx_cider_state_" }));

describe("DesktopProfileViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    let member: RoomMember;
    let me: RoomMember;
    let user: User;
    let onClose: Mock<() => void>;
    let onOpenFull: Mock<() => void>;
    let rightPanelStore: { setCards: ReturnType<typeof vi.fn> };
    let vms: DesktopProfileViewModel[];

    const create = (overrides: Partial<DesktopProfileViewModelProps> = {}): DesktopProfileViewModel => {
        const vm = new DesktopProfileViewModel({
            client,
            member,
            room,
            roleSpace: null,
            isRoomViewed: true,
            full: false,
            rightPanelStore: rightPanelStore as unknown as DesktopProfileViewModelProps["rightPanelStore"],
            onClose,
            onOpenFull,
            ...overrides,
        });
        vms.push(vm);
        return vm;
    };
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
        vms = [];
        localStorage.clear();
        client = stubClient();
        room = new Room("!room:example.org", client, client.getSafeUserId());
        member = new RoomMember(room.roomId, "@bob:example.org");
        member.name = "Bob";
        member.membership = "join";
        member.powerLevel = 0;
        me = new RoomMember(room.roomId, client.getSafeUserId());
        me.membership = "join";
        me.powerLevel = 100;
        vi.spyOn(room, "getMember").mockImplementation((id) =>
            id === member.userId ? member : id === me.userId ? me : null,
        );
        user = new User(member.userId);
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
        vi.mocked(client.getUser).mockImplementation((id) => (id === user.userId ? user : null));
        vi.mocked(client.getRoom).mockImplementation((id) => (id === room.roomId ? room : null));
        vi.mocked(client.getRooms).mockReturnValue([room]);
        vi.mocked(client.isGuest).mockReturnValue(false);
        vi.mocked(client.isUserIgnored).mockReturnValue(false);
        vi.mocked(client.getCrypto).mockReturnValue(undefined);
        client.doesServerSupportMutualRooms = vi.fn().mockResolvedValue(false);
        client.getMutualRooms = vi.fn().mockResolvedValue([]);
        vi.spyOn(room.currentState, "hasSufficientPowerLevelFor").mockReturnValue(true);
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => undefined);
        vi.mocked(findDMRoom).mockReturnValue(null);
        vi.mocked(startDmOnFirstMessage).mockResolvedValue("!dm:example.org");
        onClose = vi.fn<() => void>();
        onOpenFull = vi.fn<() => void>();
        rightPanelStore = { setCards: vi.fn() };
    });
    afterEach(() => {
        vms.forEach((vm) => vm.dispose());
        vi.restoreAllMocks();
        copy.mockReset();
    });

    it("projects the real name, Matrix ID and received presence", () => {
        const snapshot = create().getSnapshot();
        expect(snapshot).toMatchObject({
            userId: "@bob:example.org",
            displayName: "Bob",
            presence: "online",
            isMe: false,
            canMessage: true,
            canModerate: true,
            canMention: true,
        });
    });

    it("omits presence the server never reported and follows later updates", () => {
        delete user.events.presence;
        user.presence = "offline";
        const vm = create();
        expect(vm.getSnapshot().presence).toBeUndefined();
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "unavailable" } }));
        client.emit(UserEvent.LastPresenceTs, user.events.presence!, user);
        expect(vm.getSnapshot().presence).toBe("unavailable");
    });

    it("shows the standard power-level role, and the Space role when the room is in the active Space", () => {
        member.powerLevel = 50;
        expect(create().getSnapshot().roles).toEqual([{ key: "room-50", label: "Moderator" }]);

        const space = new Room("!space:example.org", client, client.getSafeUserId());
        const spaceMember = new RoomMember(space.roomId, member.userId);
        spaceMember.membership = "join";
        spaceMember.powerLevel = 100;
        vi.spyOn(space, "getMember").mockReturnValue(spaceMember);
        expect(create({ roleSpace: space }).getSnapshot().roles).toEqual([
            { key: "space-100", label: "Admin" },
            { key: "room-50", label: "Moderator" },
        ]);
    });

    it("gives a direct conversation no roles", () => {
        member.powerLevel = 100;
        vi.mocked(client.getAccountData).mockReturnValue(
            new MatrixEvent({ type: EventType.Direct, content: { [member.userId]: [room.roomId] } }),
        );
        expect(create().getSnapshot().roles).toEqual([]);
    });

    it("withholds moderation unless the viewer outranks the member and may act", () => {
        me.powerLevel = 0;
        expect(create().getSnapshot().canModerate).toBe(false);
        me.powerLevel = 100;
        vi.spyOn(room.currentState, "hasSufficientPowerLevelFor").mockReturnValue(false);
        expect(create().getSnapshot().canModerate).toBe(false);
    });

    it("offers no messaging or moderation for yourself, nor for guests", () => {
        const own = create({ member: me });
        expect(own.getSnapshot()).toMatchObject({ isMe: true, canMessage: false, canModerate: false });
        vi.mocked(client.isGuest).mockReturnValue(true);
        expect(create().getSnapshot().canMessage).toBe(false);
    });

    it("allows mentions only in the viewed, non-Space room", () => {
        expect(create({ isRoomViewed: false }).getSnapshot().canMention).toBe(false);
        vi.spyOn(room, "isSpaceRoom").mockReturnValue(true);
        expect(create().getSnapshot().canMention).toBe(false);
    });

    it("reads verification and only offers it for unverified users with sessions and cross-signing keys", async () => {
        const crypto = {
            getUserVerificationStatus: vi.fn().mockResolvedValue({ isVerified: () => false }),
            getUserDeviceInfo: vi.fn().mockResolvedValue(new Map([[member.userId, new Map([["D1", {}]])]])),
            userHasCrossSigningKeys: vi.fn().mockResolvedValue(true),
        };
        vi.mocked(client.getCrypto).mockReturnValue(crypto as never);
        const vm = create();
        expect(vm.getSnapshot().canVerify).toBe(false);
        await flush();
        expect(vm.getSnapshot()).toMatchObject({ canVerify: true, isVerified: false });

        crypto.userHasCrossSigningKeys.mockResolvedValue(false);
        const noKeys = create();
        await flush();
        expect(noKeys.getSnapshot().canVerify).toBe(false);

        vm.verify();
        expect(onClose).toHaveBeenCalled();
        expect(verifyUser).toHaveBeenCalledWith(rightPanelStore, client, user);
    });

    it("shows a status only when the feature is enabled", async () => {
        vi.mocked(SettingsStore.getValue).mockReturnValue(true);
        vi.mocked(client.doesServerSupportExtendedProfiles).mockResolvedValue(true);
        vi.mocked(client.getExtendedProfileProperty).mockImplementation(async (_id, key) => {
            if (key === "org.matrix.msc4426.status") return { emoji: "🎧", text: "Listening" };
            throw new Error("not found");
        });
        const vm = create();
        await flush();
        expect(vm.getSnapshot().status).toEqual({ emoji: "🎧", text: "Listening" });
    });

    describe("message", () => {
        it("opens the DM through Element's flow and carries no draft when empty", async () => {
            const vm = create();
            await vm.message("   ");
            expect(startDmOnFirstMessage).toHaveBeenCalledWith(
                client,
                expect.arrayContaining([expect.objectContaining({ userId: member.userId })]),
            );
            expect(onClose).toHaveBeenCalled();
            expect(localStorage.length).toBe(0);
        });

        it("stores the draft for an existing DM before opening it", async () => {
            const dm = new Room("!existing:example.org", client, client.getSafeUserId());
            vi.mocked(findDMRoom).mockReturnValue(dm);
            let draftWhenOpened: string | null = null;
            vi.mocked(startDmOnFirstMessage).mockImplementation(async () => {
                draftWhenOpened = localStorage.getItem("mx_cider_state_!existing:example.org");
                return dm.roomId;
            });
            await create({ isRoomViewed: false }).message(" hello ");
            expect(JSON.parse(draftWhenOpened!)).toEqual({ parts: [{ type: "plain", text: "hello" }] });
        });

        it("stores the draft for a new DM under the room returned by Element's flow", async () => {
            await create().message("hi there");
            expect(JSON.parse(localStorage.getItem("mx_cider_state_!dm:example.org")!)).toEqual({
                parts: [{ type: "plain", text: "hi there" }],
            });
        });

        it("appends to an existing stored draft instead of replacing it", async () => {
            localStorage.setItem(
                "mx_cider_state_!dm:example.org",
                JSON.stringify({ parts: [{ type: "plain", text: "a" }] }),
            );
            await create().message("b");
            expect(JSON.parse(localStorage.getItem("mx_cider_state_!dm:example.org")!).parts).toEqual([
                { type: "plain", text: "a" },
                { type: "plain", text: " b" },
            ]);
        });

        it("inserts into the composer when that DM is already being viewed", async () => {
            const dm = new Room("!dm:example.org", client, client.getSafeUserId());
            vi.mocked(findDMRoom).mockReturnValue(dm);
            vi.mocked(client.getRoom).mockImplementation((id) => (id === dm.roomId ? dm : null));
            vi.spyOn(dm, "getMember").mockReturnValue(member);
            await create({ room: dm }).message("hey");
            expect(defaultDispatcher.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({ action: Action.ComposerInsert, text: "hey" }),
            );
            expect(localStorage.length).toBe(0);
        });

        it("reports a failure, stays open, and allows another attempt", async () => {
            vi.mocked(startDmOnFirstMessage).mockRejectedValueOnce(new Error("nope"));
            const vm = create();
            await vm.message("x");
            expect(vm.getSnapshot()).toMatchObject({ busy: false, error: true });
            expect(onClose).not.toHaveBeenCalled();
            await vm.message("x");
            expect(onClose).toHaveBeenCalled();
        });

        it("ignores a second request while one is in flight", async () => {
            let finish: (id: string) => void = () => {};
            vi.mocked(startDmOnFirstMessage).mockReturnValue(new Promise((resolve) => (finish = resolve)));
            const vm = create();
            const first = vm.message("");
            await vm.message("");
            expect(startDmOnFirstMessage).toHaveBeenCalledTimes(1);
            finish("!dm:example.org");
            await first;
        });
    });

    it("mentions, copies the permalink, and hands moderation to the room info panel", () => {
        const vm = create();
        vm.mention();
        expect(defaultDispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ComposerInsert, userId: member.userId }),
        );
        vm.copyLink();
        expect(copy).toHaveBeenCalledWith("https://matrix.to/#/@bob:example.org");
        vm.moderate();
        expect(rightPanelStore.setCards).toHaveBeenCalledWith([
            { phase: RightPanelPhases.RoomSummary },
            { phase: RightPanelPhases.MemberList },
            { phase: RightPanelPhases.MemberInfo, state: { member } },
        ]);
    });

    it("ignores with confirmation and unignores directly", () => {
        const vm = create();
        vm.toggleIgnore();
        expect(confirmAndIgnoreUser).toHaveBeenCalledWith(client, member);
        vi.mocked(client.isUserIgnored).mockReturnValue(true);
        vm.toggleIgnore();
        expect(unignoreUser).toHaveBeenCalledWith(client, member.userId);
    });

    it("changes nothing when merely opened", () => {
        create();
        expect(client.setIgnoredUsers).not.toHaveBeenCalled();
        expect(startDmOnFirstMessage).not.toHaveBeenCalled();
        expect(defaultDispatcher.dispatch).not.toHaveBeenCalled();
        expect(rightPanelStore.setCards).not.toHaveBeenCalled();
    });

    it("refreshes when ignored users change", () => {
        const vm = create();
        vi.mocked(client.isUserIgnored).mockReturnValue(true);
        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: "m.ignored_user_list" }), undefined);
        expect(vm.getSnapshot().isIgnored).toBe(true);
    });

    describe("full profile", () => {
        it("dates the current stay from the latest join that follows a non-join state", () => {
            const events = [
                new MatrixEvent({
                    type: EventType.RoomMember,
                    state_key: member.userId,
                    origin_server_ts: Date.UTC(2026, 0, 2),
                    content: { membership: "join" },
                    unsigned: { prev_content: { membership: "leave" } },
                }),
                new MatrixEvent({
                    type: EventType.RoomMember,
                    state_key: member.userId,
                    origin_server_ts: Date.UTC(2026, 4, 3, 12),
                    content: { membership: "join", displayname: "New" },
                    unsigned: { prev_content: { membership: "join" } },
                }),
            ];
            vi.spyOn(room.getLiveTimeline(), "getEvents").mockReturnValue(events);
            vi.spyOn(room.getLiveTimeline(), "getNeighbouringTimeline").mockReturnValue(null);
            const snapshot = create({ full: true }).getSnapshot();
            expect(snapshot.memberSince?.datetime).toBe("2026-01-02T00:00:00.000Z");
            expect(create({ full: false }).getSnapshot().memberSince).toBeUndefined();
        });

        it("lists mutual rooms from the server, excluding Spaces and direct conversations", async () => {
            const shared = new Room("!shared:example.org", client, client.getSafeUserId());
            const space = new Room("!space:example.org", client, client.getSafeUserId());
            vi.spyOn(shared, "getMyMembership").mockReturnValue("join");
            vi.spyOn(space, "getMyMembership").mockReturnValue("join");
            vi.spyOn(space, "isSpaceRoom").mockReturnValue(true);
            vi.mocked(client.getRoom).mockImplementation((id) =>
                id === shared.roomId ? shared : id === space.roomId ? space : null,
            );
            vi.mocked(client.doesServerSupportMutualRooms).mockResolvedValue(true);
            vi.mocked(client.getMutualRooms).mockResolvedValue([shared.roomId, space.roomId, "!unknown:example.org"]);
            const vm = create({ full: true });
            expect(vm.getSnapshot().mutualRooms.state).toBe("loading");
            await flush();
            expect(vm.getSnapshot().mutualRooms).toMatchObject({
                state: "ready",
                items: [{ id: shared.roomId, name: shared.name }],
            });
        });

        it("marks mutual rooms unsupported without asking for them", async () => {
            vi.mocked(client.doesServerSupportMutualRooms).mockResolvedValue(false);
            const vm = create({ full: true });
            await flush();
            expect(vm.getSnapshot().mutualRooms.state).toBe("unsupported");
            expect(client.getMutualRooms).not.toHaveBeenCalled();
        });

        it("reports a failed mutual-room request and retries it", async () => {
            vi.mocked(client.doesServerSupportMutualRooms).mockResolvedValue(true);
            vi.mocked(client.getMutualRooms).mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
            const vm = create({ full: true });
            await flush();
            expect(vm.getSnapshot().mutualRooms.state).toBe("error");
            vm.retryMutualRooms();
            await flush();
            expect(vm.getSnapshot().mutualRooms).toEqual({ state: "ready", items: [] });
        });

        it("computes mutual Spaces from locally known joined members", () => {
            const space = new Room("!space:example.org", client, client.getSafeUserId());
            vi.spyOn(space, "getMyMembership").mockReturnValue("join");
            vi.spyOn(space, "isSpaceRoom").mockReturnValue(true);
            vi.spyOn(space, "getMember").mockReturnValue(member);
            vi.mocked(client.getRooms).mockReturnValue([room, space]);
            expect(create({ full: true }).getSnapshot().mutualSpaces).toMatchObject([{ id: space.roomId }]);
        });

        it("opens a mutual room and closes", () => {
            create({ full: true }).openRoom("!shared:example.org");
            expect(defaultDispatcher.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({ action: Action.ViewRoom, room_id: "!shared:example.org" }),
            );
            expect(onClose).toHaveBeenCalled();
        });
    });

    describe("rich profile", () => {
        const showAppearance = (): void => {
            vi.mocked(SettingsStore.getValue).mockImplementation(
                ((name: string) => name === "showProfileAppearance") as typeof SettingsStore.getValue,
            );
        };
        const rich = {
            "io.aether.profile": {
                decoration: "halo",
                effect: "snow",
                links: [{ label: "Site", url: "https://example.org/" }],
                board: { title: "Games", items: [{ title: "Squad" }] },
            },
            "io.fsky.nyx.pronouns": [{ summary: "they/them" }],
            "gay.fomx.biography": { "m.text": [{ body: "Hello" }] },
            "org.matrix.msc4426.status": { emoji: "🎧", text: "Listening" },
        };

        it("shows the profile once it arrives, however the status flag is set", async () => {
            showAppearance();
            client.doesServerSupportExtendedProfiles = vi.fn().mockResolvedValue(true);
            client.getExtendedProfile = vi.fn().mockResolvedValue(rich);
            const vm = create({ full: true });
            expect(vm.getSnapshot().appearance).toBeUndefined();
            await vi.waitFor(() => expect(vm.getSnapshot().bio).toBe("Hello"));
            expect(vm.getSnapshot()).toMatchObject({
                pronouns: "they/them",
                status: { emoji: "🎧", text: "Listening" },
                appearance: { decoration: "halo", effect: "snow" },
                links: [{ label: "Site", host: "example.org" }],
                board: { title: "Games" },
            });
        });

        it("hides styling for ignored people and when the viewer turned it off", async () => {
            client.doesServerSupportExtendedProfiles = vi.fn().mockResolvedValue(true);
            client.getExtendedProfile = vi.fn().mockResolvedValue(rich);
            const viewer = create();
            await flush();
            await flush();
            expect(viewer.getSnapshot().appearance).toBeUndefined();

            showAppearance();
            vi.mocked(client.isUserIgnored).mockReturnValue(true);
            const ignoring = create();
            await flush();
            expect(ignoring.getSnapshot().appearance).toBeUndefined();
            expect(ignoring.getSnapshot().bio).toBeUndefined();
        });

        it("saves a private note and reads it back into the full profile", async () => {
            client.getAccountData = vi
                .fn()
                .mockReturnValue({ getContent: () => ({ notes: { [member.userId]: "old" } }) });
            client.setAccountData = vi.fn().mockResolvedValue(undefined);
            const vm = create({ full: true });
            expect(vm.getSnapshot().note).toBe("old");
            vm.setNote("new");
            await flush();
            expect(client.setAccountData).toHaveBeenCalledWith("io.aether.user_notes", {
                notes: { [member.userId]: "new" },
            });
        });

        it("offers no notes in the popout, or about yourself", () => {
            expect(create({ full: false }).getSnapshot().note).toBeUndefined();
            const self = new RoomMember(room.roomId, client.getSafeUserId());
            expect(create({ full: true, member: self }).getSnapshot().note).toBeUndefined();
        });

        it("opens the profile editor and closes the card", () => {
            create().editProfile();
            expect(onClose).toHaveBeenCalled();
            expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
                action: Action.ViewUserSettings,
                initialTabId: "USER_PROFILE_TAB",
            });
        });
    });
});
