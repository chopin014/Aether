/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room, RoomStateEvent, RoomType, type MatrixClient } from "matrix-js-sdk/src/matrix";
import EventEmitter from "node:events";
import { MatrixRTCSessionEvent, type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { stubClient } from "test-utils";

import { VoiceUserMenuViewModel } from "./VoiceUserMenuViewModel";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import Modal from "../../Modal";
import SettingsStore from "../../settings/SettingsStore";
import { VoiceUserPreferences, VoiceUserPreferencesEvent } from "../../audio/desktop/VoiceUserPreferences";
import { findDMRoom } from "../../utils/dm/findDMRoom";
import { startDmOnFirstMessage } from "../../utils/direct-messages";
import { verifyUser } from "../../verification";
import { confirmAndIgnoreUser } from "../../components/viewmodels/right_panel/user_info/UserInfoIgnoreButtonViewModel";
import { disconnectVoiceMember, moveVoiceMember } from "../../utils/call/moveVoiceMember";
import { SERVER_VOICE_MUTE_EVENT_TYPE } from "../../utils/call/serverVoiceMute";
import { showServerNicknameDialog } from "../../components/views/desktop/DesktopServerNicknameDialog";
import { mayChangeNickname, serverOfRoom } from "../../utils/serverNickname";

vi.mock("../../components/views/desktop/DesktopServerNicknameDialog", () => ({ showServerNicknameDialog: vi.fn() }));
vi.mock("../../utils/serverNickname", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../utils/serverNickname")>()),
    serverOfRoom: vi.fn(),
    mayChangeNickname: vi.fn(() => false),
}));

vi.mock("../../Modal");
vi.mock("../../utils/dm/findDMRoom", () => ({ findDMRoom: vi.fn(() => null) }));
vi.mock("../../verification", () => ({ verifyUser: vi.fn() }));
vi.mock("../../utils/call/moveVoiceMember", () => ({ moveVoiceMember: vi.fn(), disconnectVoiceMember: vi.fn() }));
vi.mock("../../utils/direct-messages", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../utils/direct-messages")>()),
    startDmOnFirstMessage: vi.fn().mockResolvedValue("!dm:example.org"),
}));
vi.mock("../../components/viewmodels/right_panel/user_info/UserInfoIgnoreButtonViewModel", () => ({
    confirmAndIgnoreUser: vi.fn(),
    unignoreUser: vi.fn(),
}));

const ME = "@me:example.org";
const BOB = "@bob:example.org";
const ROOM_ID = "!voice:example.org";

describe("VoiceUserMenuViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    let space: Room;

    const state = (type: string, content: object, stateKey = ""): MatrixEvent =>
        new MatrixEvent({ type, state_key: stateKey, room_id: ROOM_ID, sender: ME, content });
    const join = (target: Room, userId: string): MatrixEvent =>
        new MatrixEvent({
            type: EventType.RoomMember,
            state_key: userId,
            room_id: target.roomId,
            sender: userId,
            content: { membership: KnownMembership.Join, displayname: userId === BOB ? "Bob" : "Me" },
        });

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getUserId").mockReturnValue(ME);
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        vi.mocked(client.getCrypto()!.getUserVerificationStatus).mockResolvedValue({
            isCrossSigningVerified: () => false,
        } as never);
        room = new Room(ROOM_ID, client, ME);
        room.currentState.setStateEvents([
            // Members only take their power level once the room's creation is known.
            state(EventType.RoomCreate, { creator: ME, room_version: "10" }),
            join(room, ME),
            join(room, BOB),
            state(EventType.RoomPowerLevels, { users: { [ME]: 100 }, users_default: 0 }),
        ]);
        space = new Room("!space:example.org", client, ME);
        space.name = "Terra do boi gordo";
        space.currentState.setStateEvents([join(space, ME)]);
        vi.spyOn(space, "canInvite").mockReturnValue(true);
        vi.mocked(Modal.createDialog).mockReturnValue({ finished: Promise.resolve([true]), close: vi.fn() } as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const create = (userId = BOB): VoiceUserMenuViewModel =>
        new VoiceUserMenuViewModel({ client, userId, room, spaceStore: { spacePanelSpaces: [space] } });

    it("describes another person with their roles, invites and playback", async () => {
        vi.spyOn(VoiceUserPreferences.instance, "get").mockReturnValue({
            volume: 1.5,
            muted: true,
            soundboardMuted: false,
            videoDisabled: true,
        });
        const vm = create();
        expect(vm.getSnapshot()).toMatchObject({
            displayName: "Bob",
            isSelf: false,
            canMessage: true,
            canCall: false,
            volumePercent: 150,
            muted: true,
            videoDisabled: true,
            inviteServers: [{ id: "!space:example.org", name: "Terra do boi gordo" }],
            roles: [
                { level: 100, label: "Admin", selected: false },
                { level: 50, label: "Moderator", selected: false },
                { level: 0, label: "Default", selected: true },
            ],
        });
        await vi.waitFor(() => expect(vm.getSnapshot().canVerify).toBe(true));
        vm.dispose();
    });

    it("offers a call only where a direct conversation already exists", () => {
        vi.mocked(findDMRoom).mockReturnValue(new Room("!dm:example.org", client, ME));
        const vm = create();
        expect(vm.getSnapshot().canCall).toBe(true);
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        vm.startCall();
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, room_id: "!dm:example.org", view_call: true }),
        );
        vm.dispose();
    });

    it("hides the roles from someone who cannot change power levels", () => {
        room.currentState.setStateEvents([state(EventType.RoomPowerLevels, { users: { [BOB]: 100 } })]);
        const vm = create();
        expect(vm.getSnapshot().roles).toEqual([]);
        vm.dispose();
    });

    it("describes the user's own menu with their microphone and deafen", () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "audioInputMuted" || name === "desktopVoiceUserPreferences"
                ? name === "audioInputMuted"
                    ? true
                    : {}
                : false) as typeof SettingsStore.getValue);
        const vm = create(ME);
        expect(vm.getSnapshot()).toMatchObject({
            isSelf: true,
            canMessage: false,
            canCall: false,
            microphoneMuted: true,
            deafened: false,
            inviteServers: [],
        });
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        vm.toggleMicrophoneMuted();
        vm.toggleDeafened();
        expect(dispatch).toHaveBeenCalledWith({ action: Action.ToggleDesktopMicrophone });
        expect(dispatch).toHaveBeenCalledWith({ action: Action.ToggleDesktopDeafen });
        vm.dispose();
    });

    it("keeps the person's playback in their preferences and follows changes to them", () => {
        const preferences = VoiceUserPreferences.instance;
        const setVolume = vi.spyOn(preferences, "setVolume").mockResolvedValue();
        const toggleMuted = vi.spyOn(preferences, "toggleMuted").mockResolvedValue();
        const update = vi.spyOn(preferences, "update").mockResolvedValue();
        const vm = create();
        vm.setVolume(180);
        expect(setVolume).toHaveBeenCalledWith(BOB, 1.8);
        vm.toggleMuted();
        expect(toggleMuted).toHaveBeenCalledWith(BOB);
        vm.toggleSoundboardMuted();
        expect(update).toHaveBeenCalledWith(BOB, { soundboardMuted: true });
        vm.toggleVideoDisabled();
        expect(update).toHaveBeenCalledWith(BOB, { videoDisabled: true });

        vi.spyOn(preferences, "get").mockReturnValue({
            volume: 0.4,
            muted: false,
            soundboardMuted: true,
            videoDisabled: false,
        });
        preferences.emit(VoiceUserPreferencesEvent.Changed);
        expect(vm.getSnapshot()).toMatchObject({ volumePercent: 40, soundboardMuted: true });
        vm.dispose();
    });

    it("delegates to the existing Matrix flows", async () => {
        const vm = create();
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        vm.viewProfile();
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewUser, member: room.getMember(BOB) }),
        );
        vm.mention();
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: Action.ComposerInsert, userId: BOB }));
        await vm.message();
        expect(startDmOnFirstMessage).toHaveBeenCalledWith(client, [expect.objectContaining({ userId: BOB })]);
        vm.verify();
        expect(verifyUser).toHaveBeenCalled();
        vm.toggleIgnore();
        expect(confirmAndIgnoreUser).toHaveBeenCalledWith(client, room.getMember(BOB));
        await vm.inviteToServer("!space:example.org");
        expect(client.invite).toHaveBeenCalledWith("!space:example.org", BOB);
        vm.dispose();
    });

    it("asks before giving someone the user's own level, then changes it", async () => {
        const vm = create();
        await vm.setRole(100);
        expect(Modal.createDialog).toHaveBeenCalledOnce();
        expect(client.setPowerLevel).toHaveBeenCalledWith(ROOM_ID, BOB, 100);

        vi.mocked(Modal.createDialog).mockClear();
        await vm.setRole(50);
        expect(Modal.createDialog).not.toHaveBeenCalled();
        expect(client.setPowerLevel).toHaveBeenCalledWith(ROOM_ID, BOB, 50);
        vm.dispose();
    });

    it("reports a failed invite", async () => {
        vi.mocked(client.invite).mockRejectedValue(new Error("Forbidden"));
        const vm = create();
        await vm.inviteToServer("!space:example.org");
        expect(Modal.createDialog).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ description: "Forbidden" }),
        );
        vm.dispose();
    });

    describe("in a voice channel", () => {
        let session: MatrixRTCSession;
        let voice: Room;

        /** A joined room of a server, where the user is a moderator unless `myLevel` says otherwise. */
        const serverRoom = (roomId: string, type: string, name: string, myLevel = 50): Room => {
            const created = new Room(roomId, client, ME);
            const event = (eventType: string, content: object, stateKey = ""): MatrixEvent =>
                new MatrixEvent({ type: eventType, state_key: stateKey, room_id: roomId, sender: ME, content });
            created.currentState.setStateEvents([
                event(EventType.RoomCreate, { creator: ME, room_version: "10", type }),
                join(created, ME),
                join(created, BOB),
                event(EventType.RoomPowerLevels, { users: { [ME]: myLevel }, users_default: 0, state_default: 50 }),
            ]);
            created.updateMyMembership(KnownMembership.Join);
            created.name = name;
            return created;
        };

        beforeEach(() => {
            const server = serverRoom("!server:example.org", RoomType.Space, "Server");
            voice = serverRoom("!geral1:example.org", RoomType.UnstableCall, "Geral#1");
            const other = serverRoom("!geral2:example.org", RoomType.UnstableCall, "Geral#2");
            for (const child of [voice, other]) {
                server.currentState.setStateEvents([
                    new MatrixEvent({
                        type: EventType.SpaceChild,
                        state_key: child.roomId,
                        room_id: server.roomId,
                        sender: ME,
                        content: { via: ["example.org"] },
                    }),
                ]);
            }
            const all = [server, voice, other];
            vi.mocked(client.getRooms).mockReturnValue(all);
            vi.mocked(client.getRoom).mockImplementation((id) => all.find((r) => r.roomId === id) ?? null);
            session = Object.assign(new EventEmitter(), { memberships: [] }) as unknown as MatrixRTCSession;
            vi.mocked(client.matrixRTC.getRoomSession).mockReturnValue(session);
        });

        const inCall = (...userIds: string[]): void => {
            session.memberships = userIds.map((userId) => ({ userId }) as CallMembership);
            session.emit(MatrixRTCSessionEvent.MembershipsChanged, [], session.memberships);
        };

        it("offers the server's other voice channels for someone in the call, and moves them there", () => {
            inCall(BOB);
            const vm = new VoiceUserMenuViewModel({
                client,
                userId: BOB,
                room: voice,
                spaceStore: { spacePanelSpaces: [] },
            });
            expect(vm.getSnapshot().moveDestinations).toEqual([{ id: "!geral2:example.org", name: "Geral#2" }]);
            vm.moveTo("!geral2:example.org");
            expect(moveVoiceMember).toHaveBeenCalledWith(client, voice.roomId, BOB, "!geral2:example.org");

            expect(vm.getSnapshot().canDisconnect).toBe(true);
            vm.disconnect();
            expect(disconnectVoiceMember).toHaveBeenCalledWith(client, voice.roomId, BOB);

            // They left the call meanwhile: there is nobody to move.
            inCall();
            expect(vm.getSnapshot().moveDestinations).toEqual([]);
            expect(vm.getSnapshot().canDisconnect).toBe(false);
            vm.dispose();
        });

        it("offers no move to anyone without the power to move people", () => {
            inCall(BOB);
            voice.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomPowerLevels,
                    state_key: "",
                    room_id: voice.roomId,
                    sender: ME,
                    content: { users: {}, users_default: 0, state_default: 50 },
                }),
            ]);
            const vm = new VoiceUserMenuViewModel({
                client,
                userId: BOB,
                room: voice,
                spaceStore: { spacePanelSpaces: [] },
            });
            expect(vm.getSnapshot().moveDestinations).toEqual([]);
            expect(vm.getSnapshot().canDisconnect).toBe(false);
            vm.dispose();
        });
    });

    describe("in a server's voice channel", () => {
        let voice: Room;
        let server: Room;

        /** A server whose moderators (the user, unless `myLevel` says otherwise) may mute people. */
        beforeEach(() => {
            const make = (roomId: string, type: string, myLevel: number): Room => {
                const created = new Room(roomId, client, ME);
                const event = (eventType: string, content: object, stateKey = ""): MatrixEvent =>
                    new MatrixEvent({ type: eventType, state_key: stateKey, room_id: roomId, sender: ME, content });
                created.currentState.setStateEvents([
                    event(EventType.RoomCreate, { creator: ME, room_version: "10", type }),
                    join(created, ME),
                    join(created, BOB),
                    event(EventType.RoomPowerLevels, { users: { [ME]: myLevel }, users_default: 0, state_default: 50 }),
                ]);
                created.updateMyMembership(KnownMembership.Join);
                return created;
            };
            server = make("!server:example.org", RoomType.Space, 50);
            voice = make("!geral1:example.org", RoomType.UnstableCall, 0);
            server.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.SpaceChild,
                    state_key: voice.roomId,
                    room_id: server.roomId,
                    sender: ME,
                    content: { via: ["example.org"] },
                }),
            ]);
            vi.mocked(client.getRooms).mockReturnValue([server, voice]);
            vi.mocked(client.getRoom).mockImplementation((id) => [server, voice].find((r) => r.roomId === id) ?? null);
        });

        const create = (): VoiceUserMenuViewModel =>
            new VoiceUserMenuViewModel({ client, userId: BOB, room: voice, spaceStore: { spacePanelSpaces: [] } });

        it("lets a server moderator mute and deafen the person in the whole server", async () => {
            const vm = create();
            expect(vm.getSnapshot().serverVoiceMute).toEqual({ muted: false, deafened: false });
            vm.toggleServerMuted();
            await vi.waitFor(() =>
                expect(client.sendStateEvent).toHaveBeenCalledWith(
                    server.roomId,
                    SERVER_VOICE_MUTE_EVENT_TYPE,
                    { muted: true },
                    `u:${BOB}`,
                ),
            );

            // The record comes back through sync.
            const record = new MatrixEvent({
                type: SERVER_VOICE_MUTE_EVENT_TYPE,
                state_key: `u:${BOB}`,
                room_id: server.roomId,
                sender: ME,
                content: { muted: true },
            });
            server.currentState.setStateEvents([record]);
            client.emit(RoomStateEvent.Events, record, server.currentState, null);
            expect(vm.getSnapshot().serverVoiceMute).toEqual({ muted: true, deafened: false });

            vm.toggleServerDeafened();
            await vi.waitFor(() =>
                expect(client.sendStateEvent).toHaveBeenLastCalledWith(
                    server.roomId,
                    SERVER_VOICE_MUTE_EVENT_TYPE,
                    { muted: true, deafened: true },
                    `u:${BOB}`,
                ),
            );
            vm.dispose();
        });

        it("offers nothing to someone without the power in the server", () => {
            server.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomPowerLevels,
                    state_key: "",
                    room_id: server.roomId,
                    sender: ME,
                    content: { users: {}, users_default: 0, state_default: 50 },
                }),
            ]);
            const vm = create();
            expect(vm.getSnapshot().serverVoiceMute).toBeUndefined();
            vm.dispose();
        });

        it("reports a change the homeserver refused", async () => {
            vi.mocked(client.sendStateEvent).mockRejectedValue(new Error("M_FORBIDDEN"));
            const vm = create();
            vm.toggleServerMuted();
            await vi.waitFor(() =>
                expect(Modal.createDialog).toHaveBeenCalledWith(
                    expect.anything(),
                    expect.objectContaining({ description: "M_FORBIDDEN" }),
                ),
            );
            vm.dispose();
        });
    });

    it("offers changing the person's nickname in the channel's server when the user may", () => {
        expect(create().getSnapshot().canChangeNickname).toBe(false);
        vi.mocked(serverOfRoom).mockReturnValue(space);
        vi.mocked(mayChangeNickname).mockReturnValue(true);
        const vm = create();
        expect(vm.getSnapshot().canChangeNickname).toBe(true);
        expect(mayChangeNickname).toHaveBeenCalledWith(space, ME, BOB);
        vm.changeNickname();
        expect(showServerNicknameDialog).toHaveBeenCalledWith(client, space, BOB);
        vm.dispose();
        vi.mocked(serverOfRoom).mockReturnValue(undefined);
        vi.mocked(mayChangeNickname).mockReturnValue(false);
    });
});
