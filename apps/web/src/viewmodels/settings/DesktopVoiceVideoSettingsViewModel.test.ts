/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { DesktopVoiceVideoSettingsViewModel } from "./DesktopVoiceVideoSettingsViewModel";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import { type SettingKey, SETTINGS } from "../../settings/Settings";
import MediaDeviceHandler from "../../MediaDeviceHandler";
import Modal from "../../Modal";
import { UserTab } from "../../components/views/dialogs/UserTab";
import { CallStore } from "../../stores/CallStore";
import * as sounds from "../../audio/DesktopVoiceSounds";

let stored: Map<string, unknown>;
let watchers: Map<string, Set<() => void>>;

function device(deviceId: string, label: string): MediaDeviceInfo {
    return { deviceId, label } as MediaDeviceInfo;
}

/** A settings store that remembers what is written and tells watchers, like the real one. */
function fakeSettings(): void {
    stored = new Map();
    watchers = new Map();
    const read = (name: string): unknown =>
        stored.has(name) ? stored.get(name) : SETTINGS[name as SettingKey]?.default;
    vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => read(name) as never);
    vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, name) => stored.get(name) as never);
    vi.spyOn(SettingsStore, "getDefaultValue").mockImplementation((name) => SETTINGS[name].default as never);
    vi.spyOn(SettingsStore, "canSetValue").mockReturnValue(false);
    vi.spyOn(SettingsStore, "setValue").mockImplementation(async (name, _room, _level, value) => {
        stored.set(name, value);
        for (const callback of watchers.get(name) ?? []) callback();
    });
    vi.spyOn(SettingsStore, "watchSetting").mockImplementation((name, _room, callback) => {
        const set = watchers.get(name) ?? new Set();
        set.add(callback as () => void);
        watchers.set(name, set);
        return name;
    });
    vi.spyOn(SettingsStore, "unwatchSetting").mockImplementation(() => {});
}

function fakeMediaDevices(): void {
    vi.spyOn(MediaDeviceHandler, "hasAnyLabeledDevices").mockResolvedValue(true);
    vi.spyOn(MediaDeviceHandler, "getDevices").mockResolvedValue({
        audioinput: [device("default", "Default - Headset"), device("mic-2", "USB mic")],
        audiooutput: [device("default", "Default - Headset"), device("speaker-2", "Desk speakers")],
        videoinput: [device("cam-1", "Webcam")],
    } as never);
    vi.spyOn(MediaDeviceHandler, "getAudioInput").mockImplementation(
        () => (stored.get("webrtc_audioinput") as string) ?? "default",
    );
    vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockImplementation(
        () => (stored.get("webrtc_audiooutput") as string) ?? "default",
    );
    vi.spyOn(MediaDeviceHandler, "getVideoInput").mockImplementation(
        () => (stored.get("webrtc_videoinput") as string) ?? "default",
    );
    vi.spyOn(MediaDeviceHandler, "getAudioAutoGainControl").mockImplementation(
        () => (stored.get("webrtc_audio_autoGainControl") as boolean) ?? true,
    );
    vi.spyOn(MediaDeviceHandler, "getAudioEchoCancellation").mockImplementation(
        () => (stored.get("webrtc_audio_echoCancellation") as boolean) ?? true,
    );
    vi.spyOn(MediaDeviceHandler, "getAudioNoiseSuppression").mockReturnValue(true);
    vi.spyOn(MediaDeviceHandler, "setAudioAutoGainControl").mockImplementation(async (value) => {
        await SettingsStore.setValue("webrtc_audio_autoGainControl", null, SettingLevel.DEVICE, value);
    });
    vi.spyOn(MediaDeviceHandler, "setAudioEchoCancellation").mockImplementation(async (value) => {
        await SettingsStore.setValue("webrtc_audio_echoCancellation", null, SettingLevel.DEVICE, value);
    });
    vi.spyOn(MediaDeviceHandler.instance, "setDevice").mockImplementation(async (id, kind) => {
        stored.set(`webrtc_${kind}`, id);
    });
}

describe("DesktopVoiceVideoSettingsViewModel", () => {
    let client: { setForceTURN: ReturnType<typeof vi.fn> };
    let openTab: Mock<(tab: UserTab) => void>;
    let vm: DesktopVoiceVideoSettingsViewModel;

    async function create(): Promise<DesktopVoiceVideoSettingsViewModel> {
        const model = new DesktopVoiceVideoSettingsViewModel({ client: client as unknown as MatrixClient, openTab });
        // Device names arrive after the first snapshot.
        await vi.waitFor(() => expect(model.getSnapshot().devicesVisible).toBe(true));
        return model;
    }

    beforeEach(async () => {
        fakeSettings();
        fakeMediaDevices();
        client = { setForceTURN: vi.fn() };
        openTab = vi.fn();
        vi.stubGlobal("navigator", {
            ...navigator,
            mediaDevices: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        });
        vm = await create();
    });
    afterEach(() => {
        vm.dispose();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("lists devices and marks the ones in use", () => {
        const snapshot = vm.getSnapshot();
        expect(snapshot.audioInputs.map((d) => d.label)).toEqual(["Default - Headset", "USB mic"]);
        expect(snapshot.audioInputId).toBe("default");
        // The browser reports no default camera, so the "system default" entry is added.
        expect(snapshot.videoInputs.map((d) => d.label)).toEqual(["Default Device", "Webcam"]);
    });

    it("asks for permission when device names are hidden", async () => {
        vm.dispose();
        vi.mocked(MediaDeviceHandler.hasAnyLabeledDevices).mockResolvedValue(false);
        vm = new DesktopVoiceVideoSettingsViewModel({ client: client as unknown as MatrixClient, openTab });
        await vi.waitFor(() => expect(vm.getSnapshot().audioInputs).toEqual([]));
        expect(vm.getSnapshot().devicesVisible).toBe(false);
    });

    it("switches devices through the media device handler", async () => {
        await vm.setAudioInput("mic-2");
        await vm.setAudioOutput("speaker-2");
        expect(MediaDeviceHandler.instance.setDevice).toHaveBeenCalledWith("mic-2", "audioinput");
        expect(vm.getSnapshot().audioInputId).toBe("mic-2");
        expect(vm.getSnapshot().audioOutputId).toBe("speaker-2");
    });

    it("stores volumes at device level and shows them", async () => {
        await vm.setMicrophoneVolume(30);
        await vm.setSpeakerVolume(70);
        expect(SettingsStore.setValue).toHaveBeenCalledWith("desktopMicrophoneVolume", null, SettingLevel.DEVICE, 30);
        expect(vm.getSnapshot()).toMatchObject({ microphoneVolume: 30, speakerVolume: 70 });
    });

    describe("input profiles", () => {
        it("turns off echo cancellation and automatic gain for Studio", async () => {
            await vm.setInputProfile("studio");
            const snapshot = vm.getSnapshot();
            expect(snapshot).toMatchObject({ inputProfile: "studio", echoCancellation: false, autoGainControl: false });
        });

        it("leaves the switches as they are for Custom", async () => {
            await vm.setInputProfile("studio");
            await vm.setInputProfile("custom");
            expect(vm.getSnapshot()).toMatchObject({ inputProfile: "custom", echoCancellation: false });
        });

        it("becomes Custom when a processing switch is changed by hand", async () => {
            await vm.setInputProfile("studio");
            await vm.setEchoCancellation(true);
            expect(vm.getSnapshot()).toMatchObject({ inputProfile: "custom", echoCancellation: true });
            await vm.setInputProfile("studio");
            await vm.setAutoGainControl(true);
            expect(vm.getSnapshot()).toMatchObject({ inputProfile: "custom", autoGainControl: true });
        });

        it("keeps Custom when a switch is changed in Custom", async () => {
            await vm.setAutoGainControl(false);
            expect(vm.getSnapshot()).toMatchObject({ inputProfile: "custom", autoGainControl: false });
        });
    });

    it("stores the sensitivity and input mode", async () => {
        await vm.setSensitivityAuto(false);
        await vm.setSensitivity(-35);
        await vm.setInputMode("push_to_talk");
        expect(vm.getSnapshot()).toMatchObject({ sensitivityAuto: false, sensitivity: -35, inputMode: "push_to_talk" });
    });

    describe("push to talk key", () => {
        const press = (type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}): KeyboardEvent => {
            const event = new KeyboardEvent(type, { code, cancelable: true, ...init });
            window.dispatchEvent(event);
            return event;
        };

        it("records a key with its modifiers and shows it readably", async () => {
            vm.toggleRecordingPushToTalk();
            expect(vm.getSnapshot().pushToTalk.recording).toBe(true);
            const event = press("keydown", "KeyV", { ctrlKey: true });
            expect(event.defaultPrevented).toBe(true);
            await vi.waitFor(() => expect(vm.getSnapshot().pushToTalk.key).toBe("Ctrl + V"));
            expect(stored.get("desktopPushToTalkKey")).toBe("Control+KeyV");
            expect(vm.getSnapshot().pushToTalk.recording).toBe(false);
        });

        it("keeps the recorded key away from push to talk and the page", () => {
            const other = vi.fn();
            window.addEventListener("keydown", other);
            vm.toggleRecordingPushToTalk();
            press("keydown", "KeyV");
            window.removeEventListener("keydown", other);
            expect(other).not.toHaveBeenCalled();
        });

        it("binds a modifier that is pressed and released on its own", async () => {
            vm.toggleRecordingPushToTalk();
            press("keydown", "ShiftRight", { shiftKey: true });
            expect(vm.getSnapshot().pushToTalk.recording).toBe(true);
            press("keyup", "ShiftRight");
            await vi.waitFor(() => expect(stored.get("desktopPushToTalkKey")).toBe("ShiftRight"));
        });

        it("cancels with Escape and keeps the old key", () => {
            stored.set("desktopPushToTalkKey", "KeyB");
            vm.toggleRecordingPushToTalk();
            press("keydown", "Escape");
            expect(vm.getSnapshot().pushToTalk.recording).toBe(false);
            expect(stored.get("desktopPushToTalkKey")).toBe("KeyB");
        });

        it("stops recording when the button is pressed again, and when the page closes", () => {
            vm.toggleRecordingPushToTalk();
            vm.toggleRecordingPushToTalk();
            expect(vm.getSnapshot().pushToTalk.recording).toBe(false);
            vm.toggleRecordingPushToTalk();
            vm.dispose();
            const event = press("keydown", "KeyV");
            expect(event.defaultPrevented).toBe(false);
        });

        it("clears the key and stores the release delay", async () => {
            stored.set("desktopPushToTalkKey", "KeyB");
            await vm.clearPushToTalk();
            await vm.setPushToTalkReleaseDelay(500);
            expect(vm.getSnapshot().pushToTalk).toMatchObject({ key: "", releaseDelay: 500 });
        });

        it("switches both push to talk sounds with one control", async () => {
            await vm.setPushToTalkSound(false);
            expect(stored.get("desktopVoiceSoundToggles")).toMatchObject({ pttActivate: false, pttDeactivate: false });
            expect(vm.getSnapshot().pushToTalk.soundEnabled).toBe(false);
            await vm.setPushToTalkSound(true);
            expect(vm.getSnapshot().pushToTalk.soundEnabled).toBe(true);
        });
    });

    describe("sounds", () => {
        it("lists every cue, with the extra ones marked", () => {
            const list = vm.getSnapshot().sounds;
            expect(list.filter((sound) => !sound.extra).map((sound) => sound.id)).toEqual([
                "mute",
                "unmute",
                "deafen",
                "undeafen",
                "join",
                "leave",
            ]);
            expect(list.every((sound) => sound.enabled)).toBe(true);
        });

        it("switches a cue off without touching the others", async () => {
            await vm.setSoundEnabled("deafen", false);
            const list = vm.getSnapshot().sounds;
            expect(list.find((sound) => sound.id === "deafen")!.enabled).toBe(false);
            expect(list.find((sound) => sound.id === "mute")!.enabled).toBe(true);
        });

        it("starts from the old single switch", () => {
            vm.dispose();
            stored.set("desktopVoiceSounds", false);
            vm = new DesktopVoiceVideoSettingsViewModel({ client: client as unknown as MatrixClient, openTab });
            expect(vm.getSnapshot().sounds.every((sound) => !sound.enabled)).toBe(true);
        });

        it("previews a cue even when it is off", async () => {
            const play = vi.spyOn(sounds, "playDesktopVoiceSound").mockResolvedValue();
            await vm.setSoundEnabled("join", false);
            await vm.previewSound("join");
            expect(play).toHaveBeenCalledWith("join", { preview: true });
        });
    });

    it("sends the user to the notification and help pages through the dialog", () => {
        vm.openNotificationSettings();
        vm.openHelp();
        expect(openTab).toHaveBeenNthCalledWith(1, UserTab.Notifications);
        expect(openTab).toHaveBeenNthCalledWith(2, UserTab.Help);
    });

    it("stores the voice channel switch warning and the lobby preview", async () => {
        await vm.setVoiceChannelSwitchWarning(true);
        await vm.setAlwaysPreviewVideo(true);
        await vm.setMirrorVideo(false);
        expect(vm.getSnapshot()).toMatchObject({
            voiceChannelSwitchWarning: true,
            alwaysPreviewVideo: true,
            mirrorVideo: false,
        });
        expect(SettingsStore.setValue).toHaveBeenCalledWith(
            "VideoView.flipVideoHorizontally",
            null,
            SettingLevel.ACCOUNT,
            false,
        );
    });

    describe("advanced", () => {
        it("hides direct calls and the fallback server where they do not apply", () => {
            vm.dispose();
            stored.set("enableLegacyCallsVoip", false);
            vm = new DesktopVoiceVideoSettingsViewModel({ client: client as unknown as MatrixClient, openTab });
            expect(vm.getSnapshot().peerToPeer).toBeUndefined();
            expect(vm.getSnapshot().fallbackIceServer).toBeUndefined();
        });

        it("offers and applies them where they do", async () => {
            vm.dispose();
            stored.set("enableLegacyCallsVoip", true);
            vi.mocked(SettingsStore.canSetValue).mockReturnValue(true);
            vm = new DesktopVoiceVideoSettingsViewModel({ client: client as unknown as MatrixClient, openTab });
            expect(vm.getSnapshot()).toMatchObject({ peerToPeer: true, fallbackIceServer: false });
            await vm.setPeerToPeer(false);
            expect(client.setForceTURN).toHaveBeenCalledWith(true);
            await vm.setFallbackIceServer(true);
            expect(vm.getSnapshot().fallbackIceServer).toBe(true);
        });

        it("opens the bug report dialog", () => {
            const create = vi.spyOn(Modal, "createDialog").mockReturnValue({} as never);
            vm.submitDebugLogs();
            expect(create).toHaveBeenCalledOnce();
        });
    });

    it("follows calls being open, because device changes then wait for the next call", () => {
        expect(vm.getSnapshot().inCall).toBe(false);
        vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(new Set([{}]) as never);
        void vm.setSpeakerVolume(50);
        expect(vm.getSnapshot().inCall).toBe(true);
    });

    describe("reset", () => {
        const answer = (confirmed: boolean): ReturnType<typeof vi.spyOn> =>
            vi.spyOn(Modal, "createDialog").mockReturnValue({ finished: Promise.resolve([confirmed]) } as never);

        beforeEach(async () => {
            await vm.setMicrophoneVolume(10);
            await vm.setInputProfile("studio");
            await vm.setInputMode("push_to_talk");
            await vm.setSoundEnabled("mute", false);
            await vm.setAudioInput("mic-2");
            await vm.setMirrorVideo(false);
        });

        it("restores every default once confirmed", async () => {
            answer(true);
            await vm.resetAll();
            expect(vm.getSnapshot()).toMatchObject({
                microphoneVolume: 100,
                inputProfile: "custom",
                inputMode: "voice_activity",
                echoCancellation: true,
                autoGainControl: true,
                mirrorVideo: true,
            });
            expect(vm.getSnapshot().sounds.every((sound) => sound.enabled)).toBe(true);
            expect(stored.get("webrtc_audioinput")).toBe("default");
            expect(vm.getSnapshot().audioInputId).toBe("default");
        });

        it("leaves the noise suppression setting alone", async () => {
            answer(true);
            await vm.resetAll();
            const names = vi.mocked(SettingsStore.setValue).mock.calls.map(([name]) => name);
            expect(names).not.toContain("webrtc_audio_noiseSuppression");
        });

        it("changes nothing when declined", async () => {
            answer(false);
            await vm.resetAll();
            expect(vm.getSnapshot()).toMatchObject({ microphoneVolume: 10, inputProfile: "studio" });
        });
    });

    describe("media tests", () => {
        let getUserMedia: ReturnType<typeof vi.fn>;
        let track: { stop: ReturnType<typeof vi.fn> };

        beforeEach(() => {
            track = { stop: vi.fn() };
            const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
            getUserMedia = vi.fn().mockResolvedValue(stream);
            vi.stubGlobal("navigator", {
                ...navigator,
                mediaDevices: { getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn() },
            });
        });

        it("starts and stops the camera preview, and closes it when the page goes away", async () => {
            await vm.toggleVideoTest();
            expect(vm.getSnapshot().videoTest).toMatchObject({ active: true });
            expect(vm.getSnapshot().videoTest.stream).not.toBeNull();
            await vm.toggleVideoTest();
            expect(vm.getSnapshot().videoTest).toMatchObject({ active: false, stream: null });
            expect(track.stop).toHaveBeenCalledTimes(1);
            await vm.toggleVideoTest();
            vm.dispose();
            expect(track.stop).toHaveBeenCalledTimes(2);
        });

        it("explains a blocked camera", async () => {
            getUserMedia.mockRejectedValue(new DOMException("no", "NotAllowedError"));
            await vm.toggleVideoTest();
            expect(vm.getSnapshot().videoTest).toMatchObject({ active: false, error: "denied" });
        });

        it("explains a blocked microphone", async () => {
            getUserMedia.mockRejectedValue(new DOMException("none", "NotFoundError"));
            await vm.toggleMicrophoneTest();
            expect(vm.getSnapshot().microphoneTest).toMatchObject({ active: false, error: "unavailable" });
        });

        it("stops the camera test when settings are reset", async () => {
            await vm.toggleVideoTest();
            vi.spyOn(Modal, "createDialog").mockReturnValue({ finished: Promise.resolve([true]) } as never);
            await vm.resetAll();
            expect(vm.getSnapshot().videoTest.active).toBe(false);
            expect(track.stop).toHaveBeenCalled();
        });
    });
});
