/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

// oxlint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, type MatrixClient, type RoomMember } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopVoiceControlsViewModel } from "./DesktopVoiceControlsViewModel";
import { Call, CallEvent, ElementCall, NO_SCREEN_SHARE } from "../../models/Call";
import { CallStoreEvent } from "../../stores/CallStore";
import SettingsStore from "../../settings/SettingsStore";

import { playDesktopVoiceSound } from "../../audio/DesktopVoiceSounds";

vi.mock("../../audio/DesktopVoiceSounds", () => ({ playDesktopVoiceSound: vi.fn() }));

const preferences = new Map<string, boolean>();

describe("DesktopVoiceControlsViewModel", () => {
    let client: MatrixClient;
    let vm: DesktopVoiceControlsViewModel;
    let store: EventEmitter & { connectedCalls: Set<Call> };
    let call: ElementCall;
    beforeEach(() => {
        preferences.clear();
        vi.mocked(playDesktopVoiceSound).mockClear();
        client = stubClient();
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((key, ...args) =>
            ["audioInputMuted", "desktopDeafened", "desktopMicMutedBeforeDeafen"].includes(key)
                ? (preferences.get(key) ?? false)
                : getValue(key, ...args),
        );
        vi.spyOn(SettingsStore, "setValue").mockImplementation(async (key, _room, _level, value) => {
            preferences.set(key, value as boolean);
        });
        vi.spyOn(SettingsStore, "unwatchSetting");
        store = Object.assign(new EventEmitter(), { connectedCalls: new Set<Call>() });
        // Retain the real model's mute notifications while replacing transport operations.
        call = Object.create(ElementCall.prototype) as ElementCall;
        Object.defineProperty(call, "roomId", { value: "!voice:example.org" });
        // This transport fixture skips the constructor that initializes speaking state.
        Object.defineProperty(call, "speakingUserIds", { value: new Set<string>(), writable: true });
        Object.defineProperty(call, "_screenShare", { value: NO_SCREEN_SHARE, writable: true });
        call.toggleScreenShare = vi.fn(async () => {
            call.handleScreenShare({ ...call.screenShare, sharing: !call.screenShare.sharing });
        });
        call.setDeviceMute = vi.fn(async (request) => {
            const state = { audio_enabled: true, video_enabled: false, ...call.deviceMuteState, ...request };
            call.handleDeviceMute(state);
            return state;
        });
        call.setAudioOutputEnabled = vi.fn();
        call.disconnect = vi.fn(async () => {
            store.connectedCalls.clear();
            store.emit(CallStoreEvent.ConnectedCalls);
        });
        const room = new Room(call.roomId, client, client.getSafeUserId());
        room.name = "Lounge";
        vi.mocked(client.getRoom).mockReturnValue(room);
        vm = new DesktopVoiceControlsViewModel({ client, callStore: store });
    });
    afterEach(() => {
        vm.dispose();
        vi.restoreAllMocks();
    });
    async function connect(): Promise<void> {
        store.connectedCalls.add(call);
        store.emit(CallStoreEvent.ConnectedCalls);
        await vi.waitFor(() => expect(vm.getSnapshot().busy).toBe(false));
    }
    it("saves microphone preferences before a call and reflects the real call's mute notifications", async () => {
        await vm.toggleMicrophone();
        expect(preferences.get("audioInputMuted")).toBe(true);
        expect(vm.getSnapshot().microphoneMuted).toBe(true);
        await connect();
        call.handleDeviceMute({ audio_enabled: true, video_enabled: false });
        expect(vm.getSnapshot().microphoneMuted).toBe(false);
        await vm.toggleMicrophone();
        expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: false });
        expect(vm.getSnapshot().microphoneMuted).toBe(true);
    });
    it("deafens playback and the microphone, then restores the previous microphone state", async () => {
        await connect();
        await vm.toggleDeafened();
        expect(call.setDeviceMute).toHaveBeenLastCalledWith({ audio_enabled: false });
        expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(false);
        expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: true, deafened: true });
        await vm.toggleDeafened();
        expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(true);
        expect(call.setDeviceMute).toHaveBeenLastCalledWith({ audio_enabled: true });
        expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: false, deafened: false });
    });
    it("does not unmute a previously muted microphone when undeafening", async () => {
        await connect();
        await vm.toggleMicrophone();
        await vm.toggleDeafened();
        await vm.toggleDeafened();
        expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: true, deafened: false });
    });
    it("undeafens when the user explicitly unmutes the microphone", async () => {
        await connect();
        await vm.toggleDeafened();
        await vm.toggleMicrophone();
        expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: false, deafened: false });
        expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(true);
    });
    it("restores a saved deafen preference to a newly connected call", async () => {
        await vm.toggleDeafened();
        await connect();
        expect(call.setDeviceMute).toHaveBeenLastCalledWith({ audio_enabled: false });
        expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(false);
    });
    it("keeps the actual device state and exposes errors when the call rejects a mute request", async () => {
        await connect();
        vi.mocked(call.setDeviceMute).mockRejectedValue(new Error("Device disconnected"));
        await vm.toggleMicrophone();
        expect(vm.getSnapshot()).toMatchObject({
            microphoneMuted: false,
            busy: false,
            error: "The audio control could not be changed. Please try again.",
        });
    });
    it("restores the microphone when the playback API cannot deafen", async () => {
        await connect();
        vi.mocked(call.setAudioOutputEnabled).mockImplementation(() => {
            throw new Error("Not ready");
        });
        await vm.toggleDeafened();
        expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: false, deafened: false, busy: false });
        expect(call.setDeviceMute).toHaveBeenLastCalledWith({ audio_enabled: true });
    });
    it("plays each cue only after its successful action and does not duplicate widget echoes", async () => {
        await connect();
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("join");
        await vm.toggleMicrophone();
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("mute");
        await vm.toggleMicrophone();
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("unmute");
        await vm.toggleDeafened();
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("deafen");
        await vm.toggleDeafened();
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("undeafen");
        const count = vi.mocked(playDesktopVoiceSound).mock.calls.length;
        call.handleDeviceMute({ audio_enabled: true, video_enabled: false });
        expect(playDesktopVoiceSound).toHaveBeenCalledTimes(count);
        vi.mocked(call.setDeviceMute).mockRejectedValueOnce(new Error("Device disconnected"));
        await vm.toggleMicrophone();
        expect(playDesktopVoiceSound).toHaveBeenCalledTimes(count);
        await vm.disconnect();
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("leave");
    });
    it("also sounds actual microphone changes from the call-stage controls", async () => {
        await connect();
        vi.mocked(playDesktopVoiceSound).mockClear();
        call.handleDeviceMute({ audio_enabled: false, video_enabled: false });
        expect(playDesktopVoiceSound).toHaveBeenCalledExactlyOnceWith("mute");
        call.handleDeviceMute({ audio_enabled: false, video_enabled: false });
        expect(playDesktopVoiceSound).toHaveBeenCalledTimes(1);
        call.handleDeviceMute({ audio_enabled: true, video_enabled: false });
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("unmute");
    });
    it("sounds the camera and screen share changes, however they were made", async () => {
        await connect();
        vi.mocked(playDesktopVoiceSound).mockClear();
        call.handleDeviceMute({ audio_enabled: true, video_enabled: true });
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("cameraOn");
        call.handleDeviceMute({ audio_enabled: true, video_enabled: true });
        expect(playDesktopVoiceSound).toHaveBeenCalledTimes(1);
        call.handleDeviceMute({ audio_enabled: true, video_enabled: false });
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("cameraOff");
        vi.mocked(playDesktopVoiceSound).mockClear();
        call.handleScreenShare({ available: true, sharing: true, remoteSharerIds: [] });
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("screenShareStart");
        call.handleScreenShare({ available: true, sharing: true, remoteSharerIds: ["@x:example.org"] });
        expect(playDesktopVoiceSound).toHaveBeenCalledTimes(1);
        call.handleScreenShare({ available: true, sharing: false, remoteSharerIds: [] });
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("screenShareStop");
    });
    it("sounds other people joining and leaving, but not ourselves", async () => {
        await connect();
        vi.mocked(playDesktopVoiceSound).mockClear();
        const me = { userId: client.getSafeUserId() } as RoomMember;
        const alice = { userId: "@alice:example.org" } as RoomMember;
        const devices = new Set(["D"]);
        call.emit(CallEvent.Participants, new Map([[me, devices]]), new Map());
        expect(playDesktopVoiceSound).not.toHaveBeenCalled();
        call.emit(
            CallEvent.Participants,
            new Map([
                [me, devices],
                [alice, devices],
            ]),
            new Map([[me, devices]]),
        );
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("userJoined");
        call.emit(
            CallEvent.Participants,
            new Map([[me, devices]]),
            new Map([
                [me, devices],
                [alice, devices],
            ]),
        );
        expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("userLeft");
        // A second device of the same person is not a new person.
        vi.mocked(playDesktopVoiceSound).mockClear();
        call.emit(CallEvent.Participants, new Map([[alice, new Set(["A", "B"])]]), new Map([[alice, new Set(["A"])]]));
        expect(playDesktopVoiceSound).not.toHaveBeenCalled();
    });
    it("disconnects the real call and releases all subscriptions on unmount", async () => {
        await connect();
        expect(vm.getSnapshot().roomName).toBe("Lounge");
        await vm.disconnect();
        expect(call.disconnect).toHaveBeenCalledOnce();
        expect(vm.getSnapshot().roomName).toBeUndefined();
        await connect();
        vm.dispose();
        expect(store.listenerCount(CallStoreEvent.ConnectedCalls)).toBe(0);
        expect(call.listenerCount(CallEvent.DeviceMute)).toBe(0);
        expect(call.listenerCount(CallEvent.ScreenShare)).toBe(0);
        expect(call.listenerCount(CallEvent.Participants)).toBe(0);
        expect(SettingsStore.unwatchSetting).toHaveBeenCalledTimes(2);
    });
    it("turns the camera on and off in the real call", async () => {
        await connect();
        expect(vm.getSnapshot().videoEnabled).toBe(false);
        await vm.toggleVideo();
        expect(call.setDeviceMute).toHaveBeenLastCalledWith({ video_enabled: true });
        expect(vm.getSnapshot().videoEnabled).toBe(true);
        await vm.toggleVideo();
        expect(call.setDeviceMute).toHaveBeenLastCalledWith({ video_enabled: false });
        expect(vm.getSnapshot().videoEnabled).toBe(false);
    });
    it("follows screen sharing as the call reports it, and toggles it through the call", async () => {
        await connect();
        expect(vm.getSnapshot()).toMatchObject({ screenShareAvailable: false, screenSharing: false });
        call.handleScreenShare({ available: true, sharing: false, remoteSharerIds: [] });
        expect(vm.getSnapshot()).toMatchObject({ screenShareAvailable: true, screenSharing: false });
        await vm.toggleScreenShare();
        expect(call.toggleScreenShare).toHaveBeenCalledOnce();
        expect(vm.getSnapshot().screenSharing).toBe(true);
    });
    it("explains a screen share that could not start", async () => {
        await connect();
        vi.mocked(call.toggleScreenShare).mockRejectedValueOnce(new Error("Picker dismissed"));
        await vm.toggleScreenShare();
        expect(vm.getSnapshot()).toMatchObject({
            screenSharing: false,
            busy: false,
            error: "Screen sharing could not be changed. Please try again.",
        });
    });
});
