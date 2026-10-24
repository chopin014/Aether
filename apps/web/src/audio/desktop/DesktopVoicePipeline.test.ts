/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ElementCallHandle } from "@element-hq/element-call-component/api";

import { DesktopVoicePipeline, getBrowserNoiseSuppression, getMicrophoneGateConfig } from "./DesktopVoicePipeline";
import { DesktopShortcutManager, type DesktopShortcutEvent } from "./DesktopShortcutManager";

import SettingsStore from "../../settings/SettingsStore";
import MediaDeviceHandler from "../../MediaDeviceHandler";
import { playDesktopVoiceSound } from "../DesktopVoiceSounds";

vi.mock("../DesktopVoiceSounds", () => ({ playDesktopVoiceSound: vi.fn() }));

const defaults: Record<string, unknown> = {
    "feature_desktop_shell": true,
    "VideoView.flipVideoHorizontally": true,
    "desktopMicrophoneVolume": 100,
    "desktopSpeakerVolume": 100,
    "desktopInputProfile": "custom",
    "desktopNoiseSuppression": "none",
    "desktopNoiseSuppressionStrength": 100,
    "desktopVoiceDetection": true,
    "desktopInputSensitivityAuto": true,
    "desktopInputSensitivity": -50,
    "desktopInputMode": "voice_activity",
    "desktopPushToTalkKey": "",
    "desktopPushToTalkReleaseDelay": 0,
    "audioInputMuted": false,
    "desktopDeafened": false,
};
let values: Record<string, unknown>;
let watchers: Map<string, () => void>;
let shortcutEvent: (event: DesktopShortcutEvent) => void;

function fakeHandle(): ElementCallHandle & { configureMedia: ReturnType<typeof vi.fn> } {
    return { configureMedia: vi.fn().mockResolvedValue(undefined) } as never;
}

/** Changes a setting and tells the watchers, the way SettingsStore does. */
function change(name: string, value: unknown): void {
    values[name] = value;
    watchers.get(name)?.();
}

describe("getMicrophoneGateConfig", () => {
    beforeEach(() => {
        values = { ...defaults };
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => values[name] as never);
    });
    afterEach(() => vi.restoreAllMocks());

    const plain = { noiseSuppression: null, voiceDetection: false };

    it("follows the automatic sensitivity by default, at full volume", () => {
        expect(getMicrophoneGateConfig()).toEqual({ volume: 1, threshold: "auto", pushToTalk: false, ...plain });
    });

    it("uses the manual threshold when automatic sensitivity is off", () => {
        values.desktopInputSensitivityAuto = false;
        values.desktopMicrophoneVolume = 40;
        expect(getMicrophoneGateConfig()).toEqual({ volume: 0.4, threshold: -50, pushToTalk: false, ...plain });
    });

    it("never gates or processes in the studio profile", () => {
        values.desktopInputProfile = "studio";
        values.desktopInputSensitivityAuto = false;
        values.desktopNoiseSuppression = "enhanced";
        expect(getMicrophoneGateConfig()).toEqual(expect.objectContaining({ threshold: null, ...plain }));
        expect(getBrowserNoiseSuppression()).toBe(false);
    });

    it("removes noise fully and only lets speech through in the voice isolation profile", () => {
        values.desktopInputProfile = "voice_isolation";
        values.desktopInputSensitivityAuto = false;
        values.desktopNoiseSuppressionStrength = 20;
        values.desktopVoiceDetection = false;
        expect(getMicrophoneGateConfig()).toEqual({
            volume: 1,
            threshold: "auto",
            pushToTalk: false,
            noiseSuppression: 100,
            voiceDetection: true,
        });
        expect(getBrowserNoiseSuppression()).toBe(false);
    });

    it("uses the chosen noise suppression in the custom profile", () => {
        values.desktopNoiseSuppression = "enhanced";
        values.desktopNoiseSuppressionStrength = 60;
        expect(getMicrophoneGateConfig()).toEqual(
            expect.objectContaining({ noiseSuppression: 60, voiceDetection: true }),
        );
        expect(getBrowserNoiseSuppression()).toBe(false);

        values.desktopVoiceDetection = false;
        expect(getMicrophoneGateConfig().voiceDetection).toBe(false);

        // The browser's own suppression replaces the model, which then cannot recognise speech either.
        values.desktopNoiseSuppression = "standard";
        values.desktopVoiceDetection = true;
        expect(getMicrophoneGateConfig()).toEqual(expect.objectContaining(plain));
        expect(getBrowserNoiseSuppression()).toBe(true);
    });

    it("keeps push to talk gated even before a key is assigned", () => {
        values.desktopInputMode = "push_to_talk";
        expect(getMicrophoneGateConfig().pushToTalk).toBe(true);
        values.desktopPushToTalkKey = "KeyV";
        expect(getMicrophoneGateConfig().pushToTalk).toBe(true);
    });
});

describe("DesktopVoicePipeline", () => {
    let pipeline: DesktopVoicePipeline;

    beforeEach(() => {
        values = { ...defaults };
        watchers = new Map();
        vi.spyOn(DesktopShortcutManager.instance, "onEvent").mockImplementation((listener) => {
            shortcutEvent = listener;
            return vi.fn();
        });
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => values[name] as never);
        vi.spyOn(SettingsStore, "watchSetting").mockImplementation((name, _room, callback) => {
            watchers.set(name, callback as () => void);
            return name;
        });
        vi.spyOn(SettingsStore, "unwatchSetting").mockImplementation((ref) => {
            watchers.delete(ref!);
        });
        vi.spyOn(MediaDeviceHandler, "getAudioInput").mockReturnValue("mic-1");
        vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("speaker-1");
        vi.spyOn(MediaDeviceHandler, "getVideoInput").mockReturnValue("camera-1");
        vi.spyOn(MediaDeviceHandler, "getAudioAutoGainControl").mockReturnValue(false);
        vi.spyOn(MediaDeviceHandler, "getAudioEchoCancellation").mockReturnValue(true);
        vi.mocked(playDesktopVoiceSound).mockClear();
        pipeline = new (DesktopVoicePipeline as unknown as new () => DesktopVoicePipeline)();
    });
    afterEach(() => vi.restoreAllMocks());

    it("leaves calls alone when the desktop shell is off", () => {
        values.feature_desktop_shell = false;
        const handle = fakeHandle();
        pipeline.attach(handle)();
        expect(handle.configureMedia).not.toHaveBeenCalled();
        expect(SettingsStore.watchSetting).not.toHaveBeenCalled();
    });

    it("gives a new component the chosen devices, processing, volume and microphone processor", () => {
        values.desktopSpeakerVolume = 35;
        const handle = fakeHandle();
        pipeline.attach(handle);
        expect(handle.configureMedia).toHaveBeenCalledWith({
            audioInput: "mic-1",
            audioOutput: "speaker-1",
            videoInput: "camera-1",
            autoGainControl: false,
            echoCancellation: true,
            noiseSuppression: false,
            playbackVolume: 0.35,
            mirrorLocalVideo: true,
            microphoneProcessor: pipeline.microphoneProcessor,
        });
    });

    it("sends the new value to every component when a setting changes", () => {
        const a = fakeHandle();
        const b = fakeHandle();
        pipeline.attach(a);
        pipeline.attach(b);
        a.configureMedia.mockClear();
        b.configureMedia.mockClear();
        values.desktopSpeakerVolume = 80;
        change("desktopSpeakerVolume", 80);
        expect(a.configureMedia).toHaveBeenCalledWith(expect.objectContaining({ playbackVolume: 0.8 }));
        expect(b.configureMedia).toHaveBeenCalledWith(expect.objectContaining({ playbackVolume: 0.8 }));
    });

    it("updates the microphone processor when the sensitivity or volume changes", () => {
        const setConfig = vi.spyOn(pipeline.microphoneProcessor, "setConfig");
        pipeline.attach(fakeHandle());
        values.desktopInputSensitivityAuto = false;
        change("desktopInputSensitivityAuto", false);
        expect(setConfig).toHaveBeenLastCalledWith({
            volume: 1,
            threshold: -50,
            pushToTalk: false,
            noiseSuppression: null,
            voiceDetection: false,
        });
    });

    it("stops listening once the last component is gone", () => {
        const a = fakeHandle();
        const b = fakeHandle();
        const detachA = pipeline.attach(a);
        const detachB = pipeline.attach(b);
        detachA();
        expect(watchers.size).toBeGreaterThan(0);
        detachB();
        expect(watchers.size).toBe(0);
    });

    it("preserves push to mute held before a call joins or reconnects", () => {
        vi.spyOn(DesktopShortcutManager.instance, "isHeld").mockImplementation((id) => id === "push_to_mute");
        const setMuted = vi.spyOn(pipeline.microphoneProcessor, "setShortcutMuted");
        const detach = pipeline.attach(fakeHandle());
        expect(setMuted).toHaveBeenLastCalledWith(true);
        detach();
        expect(setMuted).toHaveBeenLastCalledWith(false);
        const detachReconnected = pipeline.attach(fakeHandle());
        expect(setMuted).toHaveBeenLastCalledWith(true);
        shortcutEvent({ id: "push_to_mute", pressed: false });
        expect(setMuted).toHaveBeenLastCalledWith(false);
        detachReconnected();
    });

    it("applies push to mute without changing explicit mute/deafen preferences", () => {
        const setMuted = vi.spyOn(pipeline.microphoneProcessor, "setShortcutMuted");
        const detach = pipeline.attach(fakeHandle());
        shortcutEvent({ id: "push_to_mute", pressed: true });
        expect(setMuted).toHaveBeenLastCalledWith(true);
        values.audioInputMuted = true;
        values.desktopDeafened = true;
        shortcutEvent({ id: "push_to_mute", pressed: false, reset: true });
        expect(setMuted).toHaveBeenLastCalledWith(false);
        expect(values.audioInputMuted).toBe(true);
        expect(values.desktopDeafened).toBe(true);
        detach();
    });

    describe("push to talk", () => {
        const press = (type: "keydown" | "keyup"): void =>
            shortcutEvent({ id: "push_to_talk", pressed: type === "keydown" });

        beforeEach(() => {
            values.desktopInputMode = "push_to_talk";
            values.desktopPushToTalkKey = "Control+KeyV";
        });

        it("opens the microphone while the key is held and plays the sounds", () => {
            const setActive = vi.spyOn(pipeline.microphoneProcessor, "setPushToTalkActive");
            const detach = pipeline.attach(fakeHandle());
            press("keydown");
            expect(setActive).toHaveBeenLastCalledWith(true);
            expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("pttActivate");
            press("keyup");
            expect(setActive).toHaveBeenLastCalledWith(false);
            expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("pttDeactivate");
            detach();
        });

        it("closes immediately on backend reset even during the release delay", () => {
            vi.useFakeTimers();
            values.desktopPushToTalkReleaseDelay = 200;
            const setActive = vi.spyOn(pipeline.microphoneProcessor, "setPushToTalkActive");
            const detach = pipeline.attach(fakeHandle());
            press("keydown");
            press("keyup");
            expect(setActive).toHaveBeenLastCalledWith(true);
            shortcutEvent({ id: "push_to_talk", pressed: false, reset: true });
            expect(setActive).toHaveBeenLastCalledWith(false);
            vi.advanceTimersByTime(500);
            expect(setActive).toHaveBeenLastCalledWith(false);
            detach();
            vi.useRealTimers();
        });

        it("makes no sound while the microphone is muted or deafened", () => {
            const detach = pipeline.attach(fakeHandle());
            values.audioInputMuted = true;
            press("keydown");
            press("keyup");
            values.audioInputMuted = false;
            values.desktopDeafened = true;
            press("keydown");
            press("keyup");
            expect(playDesktopVoiceSound).not.toHaveBeenCalled();
            detach();
        });

        it("ignores the key outside a call", () => {
            const setActive = vi.spyOn(pipeline.microphoneProcessor, "setPushToTalkActive");
            const detach = pipeline.attach(fakeHandle());
            detach();
            setActive.mockClear();
            expect(setActive).not.toHaveBeenCalledWith(true);
        });

        it("starts and stops listening when the input mode changes", () => {
            const setActive = vi.spyOn(pipeline.microphoneProcessor, "setPushToTalkActive");
            const detach = pipeline.attach(fakeHandle());
            values.desktopInputMode = "voice_activity";
            change("desktopInputMode", "voice_activity");
            press("keydown");
            expect(setActive).not.toHaveBeenCalledWith(true);
            detach();
        });
    });
});
