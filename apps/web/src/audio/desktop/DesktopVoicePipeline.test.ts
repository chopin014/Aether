/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ElementCallHandle } from "@element-hq/element-call-component/api";

import { DesktopVoicePipeline, getMicrophoneGateConfig } from "./DesktopVoicePipeline";
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

    it("follows the automatic sensitivity by default, at full volume", () => {
        expect(getMicrophoneGateConfig()).toEqual({ volume: 1, threshold: "auto", pushToTalk: false });
    });

    it("uses the manual threshold when automatic sensitivity is off", () => {
        values.desktopInputSensitivityAuto = false;
        values.desktopMicrophoneVolume = 40;
        expect(getMicrophoneGateConfig()).toEqual({ volume: 0.4, threshold: -50, pushToTalk: false });
    });

    it("never gates in the studio profile", () => {
        values.desktopInputProfile = "studio";
        values.desktopInputSensitivityAuto = false;
        expect(getMicrophoneGateConfig().threshold).toBeNull();
    });

    it("only uses push to talk once a key is bound, so the microphone cannot be left dead", () => {
        values.desktopInputMode = "push_to_talk";
        expect(getMicrophoneGateConfig().pushToTalk).toBe(false);
        values.desktopPushToTalkKey = "KeyV";
        expect(getMicrophoneGateConfig().pushToTalk).toBe(true);
    });
});

describe("DesktopVoicePipeline", () => {
    let pipeline: DesktopVoicePipeline;

    beforeEach(() => {
        values = { ...defaults };
        watchers = new Map();
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
        expect(setConfig).toHaveBeenLastCalledWith({ volume: 1, threshold: -50, pushToTalk: false });
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

    describe("push to talk", () => {
        const press = (type: "keydown" | "keyup"): boolean =>
            window.dispatchEvent(new KeyboardEvent(type, { code: "KeyV" }));

        beforeEach(() => {
            values.desktopInputMode = "push_to_talk";
            values.desktopPushToTalkKey = "Control+KeyV";
        });

        it("opens the microphone while the key is held and plays the sounds", () => {
            const setActive = vi.spyOn(pipeline.microphoneProcessor, "setPushToTalkActive");
            const detach = pipeline.attach(fakeHandle());
            window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", ctrlKey: true }));
            expect(setActive).toHaveBeenLastCalledWith(true);
            expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("pttActivate");
            press("keyup");
            expect(setActive).toHaveBeenLastCalledWith(false);
            expect(playDesktopVoiceSound).toHaveBeenLastCalledWith("pttDeactivate");
            detach();
        });

        it("makes no sound while the microphone is muted or deafened", () => {
            const detach = pipeline.attach(fakeHandle());
            values.audioInputMuted = true;
            window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", ctrlKey: true }));
            press("keyup");
            values.audioInputMuted = false;
            values.desktopDeafened = true;
            window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", ctrlKey: true }));
            press("keyup");
            expect(playDesktopVoiceSound).not.toHaveBeenCalled();
            detach();
        });

        it("ignores the key outside a call", () => {
            const setActive = vi.spyOn(pipeline.microphoneProcessor, "setPushToTalkActive");
            window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", ctrlKey: true }));
            expect(setActive).not.toHaveBeenCalledWith(true);
        });

        it("starts and stops listening when the input mode changes", () => {
            const setActive = vi.spyOn(pipeline.microphoneProcessor, "setPushToTalkActive");
            const detach = pipeline.attach(fakeHandle());
            values.desktopInputMode = "voice_activity";
            change("desktopInputMode", "voice_activity");
            window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", ctrlKey: true }));
            expect(setActive).not.toHaveBeenCalledWith(true);
            detach();
        });
    });
});
