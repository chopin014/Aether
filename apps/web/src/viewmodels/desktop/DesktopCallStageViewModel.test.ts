/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

// This transport fixture needs real event subscription and cleanup.
// oxlint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import { DesktopCallStageViewModel } from "./DesktopCallStageViewModel";
import type {
    AetherCallPresentationBridge,
    AetherCallPresentationState,
    AetherMediaVolumeController,
    AetherParticipantMediaItem,
    AetherScreenShareMediaItem,
    AetherVideoAttachmentHandle,
} from "../../components/views/voip/AetherCallPresentationTypes";
import { CallEvent, type ElementCall } from "../../models/Call";
import SettingsStore from "../../settings/SettingsStore";
import { DesktopVoicePipeline } from "../../audio/desktop/DesktopVoicePipeline";
import MediaDeviceHandler, { MediaDeviceKindEnum } from "../../MediaDeviceHandler";
import ActiveWidgetStore, { ActiveWidgetStoreEvent } from "../../stores/ActiveWidgetStore";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import * as RoomInvite from "../../RoomInvite";

vi.mock("./SoundboardViewModel", () => ({
    SoundboardViewModel: { acquire: vi.fn(() => ({ vm: undefined, release: vi.fn() })) },
}));

function createVolumeController(initialVolume = 1, initialMuted = false): AetherMediaVolumeController {
    let volume = initialVolume;
    let muted = initialMuted;
    return {
        get volume() {
            return volume;
        },
        get muted() {
            return muted;
        },
        setVolume: vi.fn((next: number) => {
            volume = next;
            muted = next === 0;
        }),
        toggleMuted: vi.fn(() => {
            muted = !muted;
        }),
    };
}

function createBridgeState(overrides: Partial<AetherCallPresentationState> = {}): AetherCallPresentationState {
    return {
        phase: "in_call",
        roomId: "!voice:example.org",
        roomName: "Lobby Voice",
        connected: true,
        reconnecting: false,
        participantCount: 2,
        localAudioEnabled: true,
        localVideoEnabled: false,
        sharingScreen: false,
        canShareScreen: true,
        keyRotationSuppressed: false,
        encrypted: true,
        fatalError: null,
        screenShareError: null,
        needsDevicePermissions: false,
        permissionError: null,
        supportsReactions: true,
        ringing: null,
        participants: [],
        screenShares: [],
        lobbyPreviewVideo: null,
        screenShareQuality: {
            resolutionHeight: 1080,
            frameRate: 30,
            maxBitrate: null,
            includeSystemAudio: true,
        },
        screenSharePolicyLimits: {
            maxResolutionHeight: null,
            maxFrameRate: null,
            maxBitrate: null,
        },
        renderAudioElement: () => null,
        ...overrides,
    };
}

function createBridge(stateOverrides: Partial<AetherCallPresentationState> = {}): AetherCallPresentationBridge {
    return {
        state: createBridgeState(stateOverrides),
        actions: {
            joinCall: vi.fn(),
            returnToLobby: vi.fn(),
            requestDevicePermissions: vi.fn(),
            toggleRaisedHand: vi.fn(),
            sendReaction: vi.fn(),
            leaveCall: vi.fn(),
            reconnect: vi.fn(),
            toggleLocalAudio: vi.fn(),
            toggleLocalVideo: vi.fn(),
            startScreenShare: vi.fn(),
            stopScreenShare: vi.fn(),
            updateScreenShareQuality: vi.fn(),
            dismissScreenShareError: vi.fn(),
        },
    };
}

describe("DesktopCallStageViewModel", () => {
    const mockClient = {
        getRoom: vi.fn().mockReturnValue(null),
        getHomeserverUrl: () => "https://matrix.example.org",
    } as unknown as MatrixClient;

    const mockCall = Object.assign(new EventEmitter(), {
        soundboardUserIds: new Set<string>(),
        roomId: "!voice:example.org",
        setLocalLeavePending: vi.fn(),
        widget: {
            id: "widget-1",
            roomId: "!voice:example.org",
        },
    }) as unknown as ElementCall;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(mockCall.setLocalLeavePending).mockReset();
    });

    it("rings the other people in a conversation until they join, decline or the ringing times out", () => {
        const member = (userId: string, name: string, membership: string, avatar?: string) => ({
            userId,
            name,
            membership,
            getMxcAvatarUrl: () => avatar,
        });
        const room = {
            isElementVideoRoom: () => false,
            isCallRoom: () => false,
            getMembers: () => [
                member("@me:example.org", "Me", "join"),
                member("@bob:example.org", "Bob", "join", "mxc://example.org/bob"),
                member("@carol:example.org", "carol", "invite"),
                member("@dave:example.org", "Dave", "leave"),
            ],
        };
        const client = {
            ...mockClient,
            getRoom: vi.fn().mockReturnValue(room),
            getUserId: () => "@me:example.org",
            mxcUrlToHttp: (mxc: string) => mxc.replace("mxc://", "https://matrix.example.org/thumbnail/"),
        } as unknown as MatrixClient;
        const me = { id: "p-me", userId: "@me:example.org", displayName: "Me", local: true };
        const vm = new DesktopCallStageViewModel({
            client,
            call: mockCall,
            bridge: createBridge({
                ringing: "ringing",
                participants: [me as AetherParticipantMediaItem],
            }),
        });
        expect(vm.getSnapshot().callees).toEqual([
            {
                userId: "@bob:example.org",
                displayName: "Bob",
                avatarUrl: expect.stringContaining("bob"),
                initialLetter: "B",
            },
            { userId: "@carol:example.org", displayName: "carol", avatarUrl: undefined, initialLetter: "C" },
        ]);

        // Bob answers: he becomes a participant and the call stops ringing him.
        const bob = { id: "p-bob", userId: "@bob:example.org", displayName: "Bob", local: false };
        vm.setBridge(createBridge({ ringing: "ringing", participants: [me, bob] as AetherParticipantMediaItem[] }));
        expect(vm.getSnapshot().callees.map((callee) => callee.userId)).toEqual(["@carol:example.org"]);

        vm.setBridge(createBridge({ ringing: "timeout", participants: [me, bob] as AetherParticipantMediaItem[] }));
        expect(vm.getSnapshot().callees).toEqual([]);
        vm.dispose();
    });

    it("waits for device changes, reports failure, and ignores a late failure after disposal", async () => {
        const enumerate = vi.spyOn(MediaDeviceHandler, "getDevices").mockResolvedValue(undefined);
        let rejectChange!: (reason: Error) => void;
        const change = vi.spyOn(MediaDeviceHandler.instance, "setAudioInput").mockImplementation(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectChange = reject;
                }),
        );
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge: createBridge() });
        enumerate.mockClear();

        const pending = vm.selectAudioInput("headset");
        expect(enumerate).not.toHaveBeenCalled();
        rejectChange(new Error("Microphone disconnected"));
        await pending;
        expect(vm.getSnapshot().deviceError).toBe("Microphone disconnected");
        vm.dismissDeviceError();
        expect(vm.getSnapshot().deviceError).toBeNull();

        change.mockResolvedValueOnce(undefined);
        await vm.selectAudioInput("default");
        expect(enumerate).toHaveBeenCalledTimes(1);

        const late = vm.selectAudioInput("removed");
        vm.dispose();
        rejectChange(new Error("Late device failure"));
        await late;
        expect(vm.getSnapshot().deviceError).toBeNull();
    });

    it("toggles mute optimistically even when the bridge controller snapshot has not refreshed", () => {
        const controller = { volume: 0.6, muted: false, setVolume: vi.fn(), toggleMuted: vi.fn() };
        const vm = new DesktopCallStageViewModel({
            client: mockClient,
            call: mockCall,
            bridge: createBridge({
                participants: [
                    {
                        id: "bob",
                        userId: "@bob:example.org",
                        displayName: "Bob",
                        local: false,
                        speaking: false,
                        audioEnabled: true,
                        videoEnabled: false,
                        deafened: false,
                        mirror: false,
                        waitingForMedia: false,
                        unencryptedWarning: false,
                        encryptionStatus: "okay",
                        handRaisedAt: null,
                        reactionEmoji: null,
                        video: null,
                        microphoneVolume: controller,
                    },
                ],
            }),
        });
        vm.toggleParticipantMicrophoneMuted("bob");
        expect(vm.getSnapshot().participants[0].microphoneMuted).toBe(true);
        vm.toggleParticipantMicrophoneMuted("bob");
        expect(vm.getSnapshot().participants[0].microphoneMuted).toBe(false);
        vm.setParticipantMicrophoneVolume("bob", Number.NaN);
        expect(controller.setVolume).toHaveBeenCalledWith(1);
        vm.dispose();
    });

    it("preserves participant and screenShare encryptionStatus and stable video handles across bridge updates", () => {
        const stableVideoHandle: AetherVideoAttachmentHandle = {
            attach: vi.fn(),
            detach: vi.fn(),
        };
        const participant: AetherParticipantMediaItem = {
            id: "p-bob",
            userId: "@bob:example.org",
            displayName: "Bob",
            local: false,
            speaking: false,
            audioEnabled: true,
            videoEnabled: true,
            deafened: false,
            mirror: false,
            waitingForMedia: false,
            unencryptedWarning: false,
            encryptionStatus: "key_missing",
            handRaisedAt: null,
            reactionEmoji: null,
            video: stableVideoHandle,
            microphoneVolume: createVolumeController(1, false),
        };
        const share: AetherScreenShareMediaItem = {
            id: "s-bob",
            userId: "@bob:example.org",
            displayName: "Bob",
            local: false,
            videoEnabled: true,
            audioEnabled: true,
            unencryptedWarning: false,
            encryptionStatus: "key_invalid",
            video: stableVideoHandle,
            streamAudioVolume: createVolumeController(0.8, false),
        };

        const bridge1 = createBridge({
            participants: [participant],
            screenShares: [share],
        });
        const vm = new DesktopCallStageViewModel({
            client: mockClient,
            call: mockCall,
            bridge: bridge1,
        });

        expect(vm.getSnapshot().participants[0].encryptionStatus).toBe("key_missing");
        expect(vm.getSnapshot().screenShares[0].encryptionStatus).toBe("key_invalid");
        expect(vm.getSnapshot().participants[0].video).toBe(stableVideoHandle);

        // Simulate speaking state flip on bridge update
        const bridge2 = createBridge({
            participants: [{ ...participant, speaking: true }],
            screenShares: [share],
        });
        vm.setBridge(bridge2);

        expect(vm.getSnapshot().participants[0].speaking).toBe(true);
        expect(vm.getSnapshot().participants[0].video).toBe(stableVideoHandle);
        expect(vm.getSnapshot().participants[0].encryptionStatus).toBe("key_missing");
        const soundboardUsers = mockCall.soundboardUserIds as Set<string>;
        soundboardUsers.add(participant.userId);
        mockCall.emit(CallEvent.SoundboardUsers);
        expect(vm.getSnapshot().participants[0].soundboardPlaying).toBe(true);
        expect(vm.getSnapshot().participants[0].video).toBe(stableVideoHandle);
        soundboardUsers.clear();
        mockCall.emit(CallEvent.SoundboardUsers);
        expect(vm.getSnapshot().participants[0].soundboardPlaying).toBeUndefined();
        const listeners = mockCall.listenerCount(CallEvent.SoundboardUsers);
        vm.dispose();
        expect(mockCall.listenerCount(CallEvent.SoundboardUsers)).toBe(listeners - 1);
    });

    it("controls remote screen share audio volume independently of participant microphone volume", () => {
        const micVol = createVolumeController(1, false);
        const streamVol = createVolumeController(1, false);
        const participant: AetherParticipantMediaItem = {
            id: "p-bob",
            userId: "@bob:example.org",
            displayName: "Bob",
            local: false,
            speaking: false,
            audioEnabled: true,
            videoEnabled: false,
            deafened: false,
            mirror: false,
            waitingForMedia: false,
            unencryptedWarning: false,
            encryptionStatus: "okay",
            handRaisedAt: null,
            reactionEmoji: null,
            video: null,
            microphoneVolume: micVol,
        };
        const share: AetherScreenShareMediaItem = {
            id: "s-bob",
            userId: "@bob:example.org",
            displayName: "Bob",
            local: false,
            videoEnabled: true,
            audioEnabled: true,
            unencryptedWarning: false,
            encryptionStatus: "okay",
            video: null,
            streamAudioVolume: streamVol,
        };

        const vm = new DesktopCallStageViewModel({
            client: mockClient,
            call: mockCall,
            bridge: createBridge({ participants: [participant], screenShares: [share] }),
        });

        vm.setScreenShareAudioVolume("s-bob", 35);
        expect(streamVol.setVolume).toHaveBeenCalledWith(0.35);
        expect(micVol.setVolume).not.toHaveBeenCalled();
        expect(vm.getSnapshot().screenShares[0].streamAudioVolumePercent).toBe(35);
        expect(vm.getSnapshot().participants[0].microphoneVolumePercent).toBe(100);

        vm.toggleScreenShareAudioMuted("s-bob");
        expect(streamVol.toggleMuted).toHaveBeenCalledTimes(1);
        expect(micVol.toggleMuted).not.toHaveBeenCalled();

        vm.setParticipantMicrophoneVolume("p-bob", 60);
        expect(micVol.setVolume).toHaveBeenCalledWith(0.6);
        expect(vm.getSnapshot().participants[0].microphoneVolumePercent).toBe(60);
        expect(vm.getSnapshot().screenShares[0].streamAudioVolumePercent).toBe(35);

        vm.dispose();
    });

    it("clears desktopDeafened when unmuting local audio while deafened", () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation((setting: string) => setting === "desktopDeafened");
        const setValueSpy = vi.spyOn(SettingsStore, "setValue").mockResolvedValue(undefined);

        const bridge = createBridge({ localAudioEnabled: false });
        const vm = new DesktopCallStageViewModel({
            client: mockClient,
            call: mockCall,
            bridge,
        });

        vm.toggleLocalAudio();
        expect(setValueSpy).toHaveBeenCalledWith("desktopDeafened", null, expect.anything(), false);
        expect(bridge.actions.toggleLocalAudio).toHaveBeenCalledTimes(1);
        vm.dispose();
    });

    it("syncs screenShareQuality updates with DesktopVoicePipeline and bridge actions", async () => {
        const pipelineSpy = vi.spyOn(DesktopVoicePipeline.instance, "setScreenShareQuality");
        const bridge = createBridge();
        const vm = new DesktopCallStageViewModel({
            client: mockClient,
            call: mockCall,
            bridge,
        });

        await vm.updateScreenShareQuality({ resolutionHeight: 1440, frameRate: 60 });
        expect(pipelineSpy).toHaveBeenCalledWith(expect.objectContaining({ resolutionHeight: 1440, frameRate: 60 }));
        expect(bridge.actions.updateScreenShareQuality).toHaveBeenCalledWith(
            expect.objectContaining({
                resolutionHeight: 1440,
                frameRate: 60,
            }),
        );
        expect(vm.getSnapshot().screenShareQuality.resolutionHeight).toBe(1440);
        expect(vm.getSnapshot().screenShareQuality.frameRate).toBe(60);
        vm.dispose();
    });
    it("retains applied quality and reports an engine failure instead of committing the requested value", async () => {
        const bridge = createBridge();
        vi.mocked(bridge.actions.updateScreenShareQuality).mockRejectedValue(new Error("Encoder rejected setting"));
        const pipeline = vi.spyOn(DesktopVoicePipeline.instance, "setScreenShareQuality");
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge });
        await vm.updateScreenShareQuality({ frameRate: 15 });
        expect(vm.getSnapshot().screenShareQuality.frameRate).toBe(30);
        expect(vm.getSnapshot().deviceError).toBe("Encoder rejected setting");
        expect(pipeline).not.toHaveBeenCalled();
        vm.dispose();
    });

    it("forwards raising a hand and sending a reaction to the retained engine", () => {
        const bridge = createBridge();
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge });
        vm.toggleRaisedHand();
        vm.sendReaction("👍");
        expect(bridge.actions.toggleRaisedHand).toHaveBeenCalledOnce();
        expect(bridge.actions.sendReaction).toHaveBeenCalledWith({ emoji: "👍", name: "👍" });
        vm.dispose();
    });
    it("serializes rapid partial quality changes after the previous engine confirmation", async () => {
        const bridge = createBridge();
        let confirm!: () => void;
        vi.mocked(bridge.actions.updateScreenShareQuality).mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    confirm = resolve;
                }),
        );
        const pipeline = vi.spyOn(DesktopVoicePipeline.instance, "setScreenShareQuality");
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge });
        const resolution = vm.updateScreenShareQuality({ resolutionHeight: 720 });
        const frameRate = vm.updateScreenShareQuality({ frameRate: 15 });
        await Promise.resolve();
        expect(bridge.actions.updateScreenShareQuality).toHaveBeenCalledTimes(1);
        expect(vm.getSnapshot().screenShareQuality.resolutionHeight).toBe(1080);
        confirm();
        await Promise.all([resolution, frameRate]);
        expect(bridge.actions.updateScreenShareQuality).toHaveBeenLastCalledWith(
            expect.objectContaining({ resolutionHeight: 720, frameRate: 15 }),
        );
        expect(vm.getSnapshot().screenShareQuality).toMatchObject({ resolutionHeight: 720, frameRate: 15 });
        expect(pipeline).toHaveBeenCalledTimes(2);
        vm.dispose();
    });

    it("does not persist a late successful quality change after disposal", async () => {
        const bridge = createBridge();
        let confirm!: () => void;
        vi.mocked(bridge.actions.updateScreenShareQuality).mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    confirm = resolve;
                }),
        );
        const pipeline = vi.spyOn(DesktopVoicePipeline.instance, "setScreenShareQuality");
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge });
        const pending = vm.updateScreenShareQuality({ frameRate: 15 });
        await Promise.resolve();
        vm.dispose();
        confirm();
        await pending;
        expect(vm.getSnapshot().screenShareQuality.frameRate).toBe(30);
        expect(pipeline).not.toHaveBeenCalled();
    });

    it("enumerates labelled and anonymous devices, refreshes selections and releases listeners", async () => {
        const device = (id: string, label = ""): MediaDeviceInfo => ({
            deviceId: id,
            groupId: "",
            label,
            kind: "audioinput",
            toJSON: () => ({}),
        });
        vi.spyOn(MediaDeviceHandler, "getDevices").mockResolvedValue({
            [MediaDeviceKindEnum.AudioInput]: [device("microphone")],
            [MediaDeviceKindEnum.AudioOutput]: [device("speaker", "Desk speaker")],
            [MediaDeviceKindEnum.VideoInput]: [device("camera")],
        });
        vi.spyOn(MediaDeviceHandler, "getAudioInput").mockReturnValue("");
        vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("speaker");
        vi.spyOn(MediaDeviceHandler, "getVideoInput").mockReturnValue("camera");
        const output = vi.spyOn(MediaDeviceHandler.instance, "setAudioOutput").mockResolvedValue(undefined);
        const camera = vi.spyOn(MediaDeviceHandler.instance, "setVideoInput").mockResolvedValue(undefined);
        const unwatch = vi.spyOn(SettingsStore, "unwatchSetting");
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge: createBridge() });
        await vm.refreshDevices();
        expect(vm.getSnapshot().audioInputDevices).toEqual([
            { id: "microphone", label: "Microphone 1", selected: true },
        ]);
        expect(vm.getSnapshot().audioOutputDevices).toEqual([{ id: "speaker", label: "Desk speaker", selected: true }]);
        expect(vm.getSnapshot().videoInputDevices).toEqual([{ id: "camera", label: "Camera 1", selected: true }]);
        await vm.selectAudioOutput("speaker");
        await vm.selectVideoInput("camera");
        expect(output).toHaveBeenCalledWith("speaker");
        expect(camera).toHaveBeenCalledWith("camera");
        vm.dispose();
        expect(unwatch).toHaveBeenCalledTimes(4);
    });

    it("keeps the latest device enumeration when an older request resolves later", async () => {
        let resolveOld!: (devices: Awaited<ReturnType<typeof MediaDeviceHandler.getDevices>>) => void;
        const enumerate = vi
            .spyOn(MediaDeviceHandler, "getDevices")
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveOld = resolve;
                    }),
            )
            .mockResolvedValue({ audioinput: [], audiooutput: [], videoinput: [] });
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge: createBridge() });
        await vm.refreshDevices();
        resolveOld({
            audioinput: [{ deviceId: "removed", label: "Stale" } as MediaDeviceInfo],
            audiooutput: [],
            videoinput: [],
        });
        await Promise.resolve();
        expect(vm.getSnapshot().audioInputDevices).toEqual([]);
        vm.dispose();
        await vm.refreshDevices();
        expect(enumerate).toHaveBeenCalledTimes(2);
    });

    it("preserves menu exclusivity and resets spotlight when its media disappears", () => {
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge: createBridge() });
        vm.setOpenTileMenuId("tile");
        vm.setActiveMenu("camera");
        expect(vm.getSnapshot()).toMatchObject({ activeMenu: "camera", openTileMenuId: null });
        vm.setOpenTileMenuId("tile");
        expect(vm.getSnapshot()).toMatchObject({ activeMenu: null, openTileMenuId: "tile" });
        vm.setSpotlightTileId("missing");
        expect(vm.getSnapshot().layoutMode).toBe("spotlight");
        vm.setBridge(createBridge());
        expect(vm.getSnapshot()).toMatchObject({ layoutMode: "grid", spotlightTileId: null });
        vm.setLayoutMode("spotlight");
        vm.setLayoutMode("grid");
        vm.dispose();
        vm.setBridge(createBridge({ roomName: "Ignored" }));
        expect(vm.getSnapshot().roomName).toBe("Lobby Voice");
    });

    it("echoes leaving before calling the engine and restores participants if the action throws", () => {
        const bridge = createBridge();
        vi.mocked(bridge.actions.leaveCall).mockImplementation(() => {
            expect(mockCall.setLocalLeavePending).toHaveBeenLastCalledWith(true);
            throw new Error("Engine unavailable");
        });
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge });
        vm.leaveCall();
        expect(mockCall.setLocalLeavePending).toHaveBeenLastCalledWith(false);
        expect(vm.getSnapshot().deviceError).toBe("Engine unavailable");
        vm.dispose();
    });

    it("forwards retained lifecycle actions, reports async failures and ignores failures after disposal", async () => {
        const bridge = createBridge();
        vi.mocked(bridge.actions.sendReaction).mockRejectedValue("Reaction unavailable");
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge });
        vm.joinCall();
        vm.leaveCall();
        vm.returnToLobby();
        vm.requestDevicePermissions();
        vm.reconnect();
        vm.toggleLocalVideo();
        vm.dismissScreenShareError();
        for (const name of [
            "joinCall",
            "leaveCall",
            "returnToLobby",
            "requestDevicePermissions",
            "reconnect",
            "toggleLocalVideo",
            "dismissScreenShareError",
        ] as const) {
            expect(bridge.actions[name]).toHaveBeenCalledOnce();
        }
        vm.sendReaction("🎉");
        await Promise.resolve();
        expect(vm.getSnapshot().deviceError).toBe("Reaction unavailable");
        vm.dismissDeviceError();
        vm.dispose();
        vm.sendReaction("🎉");
        await Promise.resolve();
        expect(vm.getSnapshot().deviceError).toBeNull();
    });

    it("starts and stops a share with deployment caps and exposes capture failures", async () => {
        const bridge = createBridge({
            screenSharePolicyLimits: { maxResolutionHeight: 540, maxFrameRate: 12, maxBitrate: 750_000 },
        });
        vi.mocked(bridge.actions.startScreenShare).mockRejectedValue(new Error("Capture cancelled"));
        const vm = new DesktopCallStageViewModel({ client: mockClient, call: mockCall, bridge });
        vm.startScreenShareWithQuality({ resolutionHeight: 1440, frameRate: 60, maxBitrate: 6_000_000 });
        expect(bridge.actions.startScreenShare).toHaveBeenCalledWith(
            expect.objectContaining({ resolutionHeight: 540, frameRate: 12, maxBitrate: 750_000 }),
        );
        await Promise.resolve();
        expect(vm.getSnapshot().deviceError).toBe("Capture cancelled");
        vm.toggleScreenShare();
        expect(bridge.actions.startScreenShare).toHaveBeenCalledTimes(2);
        vm.setBridge(createBridge({ sharingScreen: true }));
        vm.toggleScreenShare();
        expect(vm.getSnapshot().sharingScreen).toBe(true);
        vm.dispose();
    });

    it("uses the existing room navigation, fullscreen and docking services", async () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        const invite = vi.spyOn(RoomInvite, "showRoomInviteDialog").mockImplementation(() => undefined);
        const docked = vi.spyOn(ActiveWidgetStore.instance, "isDocked").mockReturnValue(true);
        vi.spyOn(ActiveWidgetStore.instance, "getWidgetPersistence").mockReturnValue(true);
        const audio = vi.fn(() => null);
        const vm = new DesktopCallStageViewModel({
            client: mockClient,
            call: mockCall,
            bridge: createBridge({ renderAudioElement: audio }),
        });
        vm.openInviteDialog();
        vm.showRoomChat();
        vm.popoutCall();
        expect(invite).toHaveBeenCalledWith("!voice:example.org");
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, room_id: "!voice:example.org", view_call: false }),
        );
        expect(vm.renderAudioElement()).toBeNull();
        expect(audio).toHaveBeenCalledOnce();
        docked.mockReturnValue(false);
        ActiveWidgetStore.instance.emit(ActiveWidgetStoreEvent.Undock);
        expect(vm.getSnapshot().miniMode).toBe(true);
        const stage = document.createElement("div");
        stage.requestFullscreen = vi.fn().mockResolvedValue(undefined);
        vm.toggleFullscreen(stage);
        expect(stage.requestFullscreen).toHaveBeenCalledOnce();
        const exit = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
        Object.defineProperty(document, "fullscreenElement", { configurable: true, value: stage });
        document.dispatchEvent(new Event("fullscreenchange"));
        expect(vm.getSnapshot().isFullscreen).toBe(true);
        vm.toggleFullscreen(stage);
        expect(exit).toHaveBeenCalledOnce();
        vm.dispose();
        Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    });
});
