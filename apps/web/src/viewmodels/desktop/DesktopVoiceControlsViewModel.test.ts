/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

// oxlint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { StrictMode, useEffect } from "react";
import { render } from "test-utils-rtl";
import { useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { Room, type MatrixClient, type RoomMember } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopVoiceControlsViewModel } from "./DesktopVoiceControlsViewModel";
import { Call, CallEvent, ElementCall, NO_SCREEN_SHARE } from "../../models/Call";
import { emptyCallConnectionStats } from "../../models/CallConnectionStats";
import { CallStoreEvent } from "../../stores/CallStore";
import { DesktopShortcutManager } from "../../audio/desktop/DesktopShortcutManager";
import { type DenoiserStatus } from "../../audio/desktop/denoiser/DenoiserStatus";

import SettingsStore from "../../settings/SettingsStore";
import MediaDeviceHandler, { MediaDeviceKindEnum } from "../../MediaDeviceHandler";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { UserTab } from "../../components/views/dialogs/UserTab";

import { playDesktopVoiceSound } from "../../audio/DesktopVoiceSounds";

vi.mock("../../audio/DesktopVoiceSounds", () => ({ playDesktopVoiceSound: vi.fn() }));

const microphone = vi.hoisted(() => ({
    start: vi.fn<() => Promise<void>>(),
    setPlayback: vi.fn<(enabled: boolean) => Promise<void>>(),
    stop: vi.fn(),
    update: vi.fn(),
    onLevel: undefined as ((level: number, open: boolean) => void) | undefined,
    onStatus: undefined as ((status: DenoiserStatus) => void) | undefined,
}));

vi.mock("../../audio/desktop/MicrophoneTest", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../audio/desktop/MicrophoneTest")>()),
    MicrophoneTest: class {
        public start = microphone.start;
        public setPlayback = microphone.setPlayback;
        public stop = microphone.stop;
        public update = microphone.update;
        public constructor(onLevel: typeof microphone.onLevel, onStatus: typeof microphone.onStatus) {
            microphone.onLevel = onLevel;
            microphone.onStatus = onStatus;
        }
    },
}));

const preferences = new Map<string, unknown>();

describe("DesktopVoiceControlsViewModel", () => {
    let client: MatrixClient;
    let vm: DesktopVoiceControlsViewModel;
    let store: EventEmitter & { connectedCalls: Set<Call> };
    let call: ElementCall;
    beforeEach(() => {
        microphone.start.mockReset().mockResolvedValue(undefined);
        microphone.setPlayback.mockReset().mockResolvedValue(undefined);
        microphone.stop.mockReset();
        microphone.update.mockReset();
        preferences.clear();
        vi.mocked(playDesktopVoiceSound).mockClear();
        client = stubClient();
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((key, ...args) =>
            preferences.has(key) || ["audioInputMuted", "desktopDeafened", "desktopMicMutedBeforeDeafen"].includes(key)
                ? ((preferences.get(key) ?? false) as never)
                : getValue(key, ...args),
        );
        vi.spyOn(SettingsStore, "setValue").mockImplementation(async (key, _room, _level, value) => {
            preferences.set(key, value as boolean);
        });
        vi.spyOn(SettingsStore, "unwatchSetting");
        vi.spyOn(SettingsStore, "watchSetting");
        store = Object.assign(new EventEmitter(), { connectedCalls: new Set<Call>() });
        // Retain the real model's mute notifications while replacing transport operations.
        call = Object.create(ElementCall.prototype) as ElementCall;
        Object.defineProperty(call, "roomId", { value: "!voice:example.org" });
        Object.defineProperty(call, "locallyLeaving", { value: false, writable: true });
        call.setLocalLeavePending = vi.fn((pending) => {
            Object.defineProperty(call, "locallyLeaving", { value: pending, writable: true });
            call.emit(CallEvent.Participants, new Map(), new Map());
        });
        // This transport fixture skips the constructor that initializes speaking state.
        Object.defineProperty(call, "speakingUserIds", { value: new Set<string>(), writable: true });
        Object.defineProperty(call, "_screenShare", { value: NO_SCREEN_SHARE, writable: true });
        Object.defineProperty(call, "_connectionStats", {
            value: emptyCallConnectionStats("connecting"),
            writable: true,
        });
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
        call.setLocalLeavePending(false);
        store.connectedCalls.add(call);
        store.emit(CallStoreEvent.ConnectedCalls);
        await vi.waitFor(() => expect(vm.getSnapshot().busy).toBe(false));
    }
    it("hides the dock immediately while hangup is pending and ignores late transport updates", async () => {
        await connect();
        vm.setPanel("noise");
        const hangup = Promise.withResolvers<void>();
        vi.mocked(call.disconnect).mockImplementation(async () => {
            await hangup.promise;
            store.connectedCalls.clear();
            store.emit(CallStoreEvent.ConnectedCalls);
        });

        const leaving = vm.disconnect();
        expect(vm.getSnapshot()).toMatchObject({ roomName: undefined, panel: null });
        expect(vm.getSnapshot().connection.state).toBe("disconnected");
        expect(store.connectedCalls.has(call)).toBe(true);
        call.handleConnectionStats(emptyCallConnectionStats("connected"));
        call.handleDeviceMute({ audio_enabled: true, video_enabled: true });
        expect(vm.getSnapshot().roomName).toBeUndefined();

        hangup.resolve();
        await leaving;
        expect(vm.getSnapshot().roomName).toBeUndefined();
        expect(store.connectedCalls.size).toBe(0);
    });

    it("restores the dock and reports a rejected disconnect", async () => {
        await connect();
        vi.mocked(call.disconnect).mockRejectedValue(new Error("Leave failed"));
        await vm.disconnect();
        expect(call.locallyLeaving).toBe(false);
        expect(vm.getSnapshot().roomName).toBe("Lounge");
        expect(vm.getSnapshot().error).toBeDefined();
    });

    it("routes configured focused shortcuts through the production call mute/deafen actions", async () => {
        vm.dispose();
        preferences.set("feature_desktop_shell", true);
        preferences.set("desktopShortcutBindings", { toggle_mute: "Control+KeyM", toggle_deafen: "Control+KeyD" });
        vm = new DesktopVoiceControlsViewModel({ client, callStore: store });
        vm.startShortcuts();
        await connect();
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true }));
        await vi.waitFor(() => expect(vm.getSnapshot().microphoneMuted).toBe(true));
        window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyM" }));
        await vi.waitFor(() => expect(vm.getSnapshot().busy).toBe(false));
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", ctrlKey: true }));
        await vi.waitFor(() => expect(vm.getSnapshot().deafened).toBe(true));
        expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(false);
        window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
        await vi.waitFor(() => expect(vm.getSnapshot().busy).toBe(false));
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", ctrlKey: true }));
        await vi.waitFor(() => expect(vm.getSnapshot().deafened).toBe(false));
        expect(vm.getSnapshot().microphoneMuted).toBe(true);
        vm.dispose();
        const calls = vi.mocked(call.setDeviceMute).mock.calls.length;
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true }));
        expect(call.setDeviceMute).toHaveBeenCalledTimes(calls);
    });

    it("registers only the committed VM and supports idempotent effect cleanup", async () => {
        vm.dispose();
        preferences.set("feature_desktop_shell", true);
        preferences.set("desktopShortcutBindings", { toggle_mute: "Control+KeyM" });
        const discarded = new DesktopVoiceControlsViewModel({ client, callStore: store });
        vm = new DesktopVoiceControlsViewModel({ client, callStore: store });
        const start = vi.spyOn(DesktopShortcutManager.instance, "start");
        const ignored = vi.spyOn(discarded, "toggleMicrophone");
        const active = vi.spyOn(vm, "toggleMicrophone");
        const cleanup = vm.startShortcuts();
        expect(vm.startShortcuts()).toBe(cleanup);
        expect(start).toHaveBeenCalledOnce();
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true }));
        await vi.waitFor(() => expect(active).toHaveBeenCalledOnce());
        expect(ignored).not.toHaveBeenCalled();
        window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyM" }));
        cleanup();
        cleanup();
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true }));
        expect(active).toHaveBeenCalledOnce();
        vm.startShortcuts();
        vm.dispose();
        vm.startShortcuts();
        expect(start).toHaveBeenCalledTimes(2);
        discarded.dispose();
    });

    it("runs each shortcut once through the actual StrictMode hook and effect composition", async () => {
        vm.dispose();
        preferences.set("feature_desktop_shell", true);
        preferences.set("desktopShortcutBindings", { toggle_mute: "Control+KeyM" });
        const created: DesktopVoiceControlsViewModel[] = [];
        function Owner(): React.JSX.Element {
            const voice = useCreateAutoDisposedViewModel(() => {
                const model = new DesktopVoiceControlsViewModel({ client, callStore: store });
                created.push(model);
                return model;
            });
            useEffect(() => voice.startShortcuts(), [voice]);
            return React.createElement(React.Fragment);
        }
        const owner = render(React.createElement(StrictMode, undefined, React.createElement(Owner)));
        const calls = vi.spyOn(SettingsStore, "setValue");
        calls.mockClear();
        expect(created.length).toBeGreaterThan(1);
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true }));
        await vi.waitFor(() => expect(preferences.get("audioInputMuted")).toBe(true));
        expect(calls.mock.calls.filter(([name]) => name === "audioInputMuted")).toHaveLength(1);
        owner.unmount();
        window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyM" }));
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true }));
        expect(calls.mock.calls.filter(([name]) => name === "audioInputMuted")).toHaveLength(1);
        created.forEach((model) => model.dispose());
    });

    it("serializes overlapping shortcut/device actions and preserves mute intent", async () => {
        await connect();
        await Promise.all([vm.toggleMicrophone(), vm.toggleDeafened()]);
        expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: true, deafened: true });
        await vm.toggleDeafened();
        expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: true, deafened: false });
    });

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
        expect(call.listenerCount(CallEvent.ConnectionStats)).toBe(0);
        expect(SettingsStore.unwatchSetting).toHaveBeenCalledTimes(
            vi.mocked(SettingsStore.watchSetting).mock.calls.length,
        );
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

    describe("quick voice panels", () => {
        it("edits the effective preset while retaining its other processing choices", async () => {
            preferences.set("desktopInputProfile", "voice_isolation");
            await vm.setNoiseSuppressionStrength(67.6);
            expect(preferences.get("desktopInputProfile")).toBe("custom");
            expect(preferences.get("desktopVoiceDetection")).toBe(true);
            expect(preferences.get("desktopInputSensitivityAuto")).toBe(true);
            expect(vm.getSnapshot()).toMatchObject({ noiseSuppression: true, noiseSuppressionStrength: 68 });
            await vm.setNoiseSuppression(false);
            expect(preferences.get("desktopNoiseSuppression")).toBe("none");
            expect(vm.getSnapshot().noiseSuppression).toBe(false);
            await vm.setNoiseSuppression(true);
            expect(vm.getSnapshot()).toMatchObject({ noiseSuppression: true, noiseSuppressionStrength: 68 });
        });

        it("bounds strength without accepting invalid values", async () => {
            await vm.setNoiseSuppressionStrength(-1);
            expect(preferences.get("desktopNoiseSuppressionStrength")).toBe(0);
            await vm.setNoiseSuppressionStrength(101);
            expect(preferences.get("desktopNoiseSuppressionStrength")).toBe(100);
            const saves = vi.mocked(SettingsStore.setValue).mock.calls.length;
            await vm.setNoiseSuppressionStrength(Number.NaN);
            expect(SettingsStore.setValue).toHaveBeenCalledTimes(saves);
        });

        it("opens a panel without capturing, then tests locally with a temporarily deafened call", async () => {
            await connect();
            vm.setPanel("noise");
            expect(microphone.start).not.toHaveBeenCalled();
            await vm.toggleMicrophoneTest();
            expect(microphone.start).toHaveBeenCalledWith({ playback: false });
            expect(microphone.setPlayback).toHaveBeenCalledWith(true);
            expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(false);
            expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: true, deafened: true });
            microphone.onLevel?.(-24, true);
            expect(vm.getSnapshot().microphoneTest).toMatchObject({ active: true, level: -24, open: true });
            await vm.toggleMicrophoneTest();
            expect(microphone.stop).toHaveBeenCalled();
            expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(true);
            expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: false, deafened: false });
        });

        it("preserves mute and a deafen the user had already chosen", async () => {
            await connect();
            await vm.toggleMicrophone();
            vm.setPanel("noise");
            await vm.toggleMicrophoneTest();
            await vm.toggleMicrophoneTest();
            expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: true, deafened: false });
            await vm.toggleDeafened();
            await vm.toggleMicrophoneTest();
            await vm.toggleMicrophoneTest();
            expect(vm.getSnapshot()).toMatchObject({ microphoneMuted: true, deafened: true });
        });

        it("restores call audio when closing the panel or disposing the dock", async () => {
            await connect();
            vm.setPanel("noise");
            await vm.toggleMicrophoneTest();
            vm.setPanel("connection");
            await vi.waitFor(() => expect(vm.getSnapshot().deafened).toBe(false));
            expect(vm.getSnapshot().microphoneTest.active).toBe(false);
            vm.setPanel("noise");
            await vm.toggleMicrophoneTest();
            vm.dispose();
            await vi.waitFor(() => expect(preferences.get("desktopDeafened")).toBe(false));
            expect(preferences.get("audioInputMuted")).toBe(false);
            expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(true);
            expect(call.setDeviceMute).toHaveBeenLastCalledWith({ audio_enabled: true });
        });

        it("keeps call controls usable during permission prompts and cancels playback on close", async () => {
            const opening = Promise.withResolvers<void>();
            microphone.start.mockReturnValueOnce(opening.promise);
            await connect();
            vm.setPanel("noise");
            const starting = vm.toggleMicrophoneTest();
            expect(vm.getSnapshot().busy).toBe(false);
            vm.setPanel(null);
            opening.resolve();
            await starting;
            expect(microphone.setPlayback).not.toHaveBeenCalled();
            expect(vm.getSnapshot().microphoneTest.active).toBe(false);
        });

        it("restores audio after an in-flight test deafen finishes during disposal", async () => {
            await connect();
            const pending = Promise.withResolvers<void>();
            const setDeviceMute = vi.mocked(call.setDeviceMute).getMockImplementation()!;
            vi.mocked(call.setDeviceMute).mockImplementationOnce(async (request) => {
                await pending.promise;
                return setDeviceMute(request);
            });
            vm.setPanel("noise");
            const starting = vm.toggleMicrophoneTest();
            await vi.waitFor(() => expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: false }));
            vm.dispose();
            pending.resolve();
            await starting;
            await vi.waitFor(() => expect(preferences.get("desktopDeafened")).toBe(false));
            expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(true);
            expect(call.setDeviceMute).toHaveBeenLastCalledWith({ audio_enabled: true });
            expect(microphone.setPlayback).not.toHaveBeenCalled();
        });

        it("releases the test and restores preferences when the call ends elsewhere", async () => {
            await connect();
            vm.setPanel("noise");
            await vm.toggleMicrophoneTest();
            vi.mocked(call.setDeviceMute).mockClear();
            store.connectedCalls.clear();
            store.emit(CallStoreEvent.ConnectedCalls);
            await vi.waitFor(() => expect(preferences.get("desktopDeafened")).toBe(false));
            expect(preferences.get("audioInputMuted")).toBe(false);
            expect(call.setDeviceMute).not.toHaveBeenCalled();
            expect(vm.getSnapshot()).toMatchObject({
                panel: null,
                roomName: undefined,
                microphoneTest: { active: false },
            });
        });

        it("reports microphone and denoiser failures and restores the call after playback fails", async () => {
            vm.setPanel("noise");
            microphone.start.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
            await vm.toggleMicrophoneTest();
            expect(vm.getSnapshot().microphoneTest).toMatchObject({ active: false, error: "denied" });
            await connect();
            vm.setPanel("noise");
            microphone.setPlayback.mockRejectedValueOnce(new Error("Output unavailable"));
            await vm.toggleMicrophoneTest();
            expect(vm.getSnapshot()).toMatchObject({ deafened: false, microphoneMuted: false });
            expect(vm.getSnapshot().microphoneTest).toMatchObject({ active: false, error: "unavailable" });
            microphone.onStatus?.("overloaded");
            expect(vm.getSnapshot().noiseSuppressionProblem).toBe("overloaded");
        });

        it("reflects real connection reports and clears the previous call's diagnostics", async () => {
            await connect();
            call.handleConnectionStats({
                state: "connected",
                quality: "poor",
                rttMs: 280,
                averageRttMs: 200,
                outboundPacketLossPercent: 6,
                history: [120, 280],
            });
            expect(vm.getSnapshot().connection).toMatchObject({ quality: "poor", rttMs: 280 });
            await vm.disconnect();
            expect(vm.getSnapshot().connection).toMatchObject({ state: "disconnected", rttMs: null, history: [] });
        });
    });

    describe("device menus", () => {
        function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
            return { kind, deviceId, label, groupId: "", toJSON: () => ({}) };
        }

        beforeEach(() => {
            vi.spyOn(MediaDeviceHandler, "getDevices").mockResolvedValue({
                [MediaDeviceKindEnum.AudioInput]: [
                    device("audioinput", "default", "Default - Built-in Microphone"),
                    device("audioinput", "headset", "USB Headset Microphone"),
                    // Permission not granted for this one yet, so it has no label to show.
                    device("audioinput", "hidden", ""),
                ],
                [MediaDeviceKindEnum.AudioOutput]: [device("audiooutput", "speakers", "Desk Speakers")],
                [MediaDeviceKindEnum.VideoInput]: [],
            });
            vi.spyOn(MediaDeviceHandler, "getAudioInput").mockReturnValue("headset");
            vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("unplugged");
        });

        it("lists labelled devices when a device menu opens and shows each one's choice", async () => {
            vm.setPanel("input");
            await vi.waitFor(() => expect(vm.getSnapshot().audioInputs).toHaveLength(2));
            expect(vm.getSnapshot()).toMatchObject({
                audioInputs: [
                    { id: "default", label: "Default - Built-in Microphone" },
                    { id: "headset", label: "USB Headset Microphone" },
                ],
                // The browser reports no default speaker, so the system default is offered first.
                audioOutputs: [
                    { id: "", label: "Default Device" },
                    { id: "speakers", label: "Desk Speakers" },
                ],
                audioInputId: "headset",
                // A speaker that is no longer connected falls back to the first one.
                audioOutputId: "",
            });
        });

        it("switches devices through the media device handler", async () => {
            const setDevice = vi.spyOn(MediaDeviceHandler.instance, "setDevice").mockResolvedValue();
            await vm.setAudioInput("default");
            expect(setDevice).toHaveBeenCalledWith("default", MediaDeviceKindEnum.AudioInput);
            await vm.setAudioOutput("speakers");
            expect(setDevice).toHaveBeenCalledWith("speakers", MediaDeviceKindEnum.AudioOutput);

            setDevice.mockRejectedValueOnce(new Error("NotReadableError"));
            await vm.setAudioInput("headset");
            expect(vm.getSnapshot().error).toBe("The device could not be changed. Please try again.");
        });

        it("saves microphone and speaker volumes within 0–100%", async () => {
            await vm.setMicrophoneVolume(64.4);
            await vm.setSpeakerVolume(140);
            expect(preferences.get("desktopMicrophoneVolume")).toBe(64);
            expect(preferences.get("desktopSpeakerVolume")).toBe(100);
        });

        it("keeps a device menu open across joining a call, unlike the call's own panels", async () => {
            vm.setPanel("output");
            await connect();
            expect(vm.getSnapshot().panel).toBe("output");
            vm.setPanel("connection");
            await vm.disconnect();
            expect(vm.getSnapshot().panel).toBeNull();
        });

        it("closes the menu and opens the Voice & Video settings", () => {
            const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
            vm.setPanel("input");
            vm.openVoiceSettings();
            expect(vm.getSnapshot().panel).toBeNull();
            expect(dispatch).toHaveBeenCalledWith({ action: Action.ViewUserSettings, initialTabId: UserTab.Voice });
        });
    });
});
