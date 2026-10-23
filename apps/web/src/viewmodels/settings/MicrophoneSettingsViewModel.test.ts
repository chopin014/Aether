/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicrophoneSettingsViewModel } from "./MicrophoneSettingsViewModel";
import { SettingLevel } from "../../settings/SettingLevel";

const mocks = vi.hoisted(() => ({
    getValue: vi.fn<(setting: string) => number | boolean>(),
    setValue: vi.fn(),
    watchSetting: vi.fn(),
    unwatchSetting: vi.fn(),
    setDevice: vi.fn(),
    createProcessor: vi.fn(),
}));

vi.mock("../../settings/SettingsStore", () => ({ default: mocks }));
vi.mock("../../MediaDeviceHandler", () => ({
    default: {
        instance: { setDevice: mocks.setDevice },
        getAudioInput: () => "usb-mic",
        getAudioOutput: () => "headphones",
        getAudioEchoCancellation: () => true,
        getAudioNoiseSuppression: () => true,
        getAudioAutoGainControl: () => false,
    },
    MediaDeviceKindEnum: { AudioInput: "audioinput", AudioOutput: "audiooutput" },
}));
vi.mock("../../audio/NoiseSuppressionProcessor", () => ({
    NoiseSuppressionProcessor: class {
        public constructor(onLevel: (db: number, detected: boolean, threshold: number) => void) {
            return mocks.createProcessor(onLevel);
        }
    },
}));

function makeTrack(): MediaStreamTrack {
    return { stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
}

function makeStream(track = makeTrack()): MediaStream {
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

describe("MicrophoneSettingsViewModel", () => {
    let vm: MicrophoneSettingsViewModel;
    let input: MediaStream;
    let mediaDevices: EventTarget & {
        getUserMedia: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>;
        enumerateDevices: ReturnType<typeof vi.fn<() => Promise<MediaDeviceInfo[]>>>;
    };
    let playback: HTMLAudioElement;
    let processor: {
        processedTrack: MediaStreamTrack | undefined;
        init: ReturnType<typeof vi.fn<() => Promise<void>>>;
        destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
    };
    let values: Record<string, boolean | number>;
    let watchers: Map<string, { setting: string; callback: () => void }>;
    let onLevel: (db: number, detected: boolean, threshold: number) => void;
    const devices = [
        { kind: "audioinput", deviceId: "usb-mic", label: "USB microphone" },
        { kind: "audiooutput", deviceId: "headphones", label: "Headphones" },
    ] as MediaDeviceInfo[];

    function changeSetting(setting: string, value: boolean | number): void {
        values[setting] = value;
        for (const watcher of watchers.values()) {
            if (watcher.setting === setting) watcher.callback();
        }
    }

    async function startTest(): Promise<void> {
        vm.toggleTest();
        await vi.waitFor(() => expect(vm.getSnapshot().testing).toBe(true));
    }

    beforeEach(() => {
        vi.clearAllMocks();
        input = makeStream();
        mediaDevices = Object.assign(new EventTarget(), {
            getUserMedia: vi.fn<() => Promise<MediaStream>>().mockResolvedValue(input),
            enumerateDevices: vi.fn<() => Promise<MediaDeviceInfo[]>>().mockResolvedValue(devices),
        });
        vi.stubGlobal("navigator", { mediaDevices });
        vi.stubGlobal(
            "MediaStream",
            vi.fn(function (tracks: MediaStreamTrack[]) {
                return makeStream(tracks[0]);
            }),
        );
        playback = document.createElement("audio");
        playback.play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
        playback.pause = vi.fn();
        playback.setSinkId = vi.fn<(sink: string) => Promise<void>>().mockResolvedValue(undefined);
        vi.stubGlobal(
            "Audio",
            vi.fn(function () {
                return playback;
            }),
        );
        processor = {
            processedTrack: makeTrack(),
            init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
            destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        mocks.createProcessor.mockImplementation((callback) => {
            onLevel = callback;
            return processor;
        });
        values = {
            webrtc_audio_inputVolume: 100,
            webrtc_audio_microphoneTestVolume: 50,
            webrtc_audio_automaticSensitivity: true,
            webrtc_audio_sensitivity: -50,
        };
        watchers = new Map();
        mocks.getValue.mockImplementation((setting) => values[setting]);
        mocks.watchSetting.mockImplementation((setting: string, _room: null, callback: () => void) => {
            const id = String(mocks.watchSetting.mock.calls.length);
            watchers.set(id, { setting, callback });
            return id;
        });
        mocks.unwatchSetting.mockImplementation((id: string) => watchers.delete(id));
        mocks.setValue.mockImplementation(
            async (setting: string, _room: null, _level: SettingLevel, value: number | boolean) => {
                changeSetting(setting, value);
            },
        );
        mocks.setDevice.mockResolvedValue(undefined);
        vm = new MicrophoneSettingsViewModel();
    });

    afterEach(() => {
        vm.dispose();
        document.body.replaceChildren();
        vi.unstubAllGlobals();
    });

    it("should enumerate devices and restore preferences without capturing audio", async () => {
        await vi.waitFor(() => expect(vm.getSnapshot().microphones).toHaveLength(2));
        expect(vm.getSnapshot()).toMatchObject({
            microphoneId: "usb-mic",
            speakerId: "headphones",
            inputVolume: 100,
            testVolume: 50,
            testing: false,
            starting: false,
            levelDb: -100,
        });
        expect(vm.getSnapshot().microphones[0]).toEqual({ id: "default", label: "System default" });
        expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(mocks.createProcessor).not.toHaveBeenCalled();
    });

    it("should preview the processed track on the selected output and receive live levels", async () => {
        await startTest();
        expect(mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({
            audio: {
                deviceId: { exact: "usb-mic" },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: false,
            },
            video: false,
        });
        expect(processor.init).toHaveBeenCalledWith({ track: input.getAudioTracks()[0] });
        expect((playback.srcObject as MediaStream).getAudioTracks()).toEqual([processor.processedTrack]);
        expect(playback.setSinkId).toHaveBeenCalledWith("headphones");
        expect(playback.volume).toBe(0.5);
        expect(playback.play).toHaveBeenCalledOnce();
        expect(playback.isConnected).toBe(true);
        onLevel(-25.3, true, -45.9);
        expect(vm.getSnapshot()).toMatchObject({ levelDb: -25, voiceDetected: true, effectiveThresholdDb: -46 });
    });

    it("should release capture, processor and playback when stopped", async () => {
        await startTest();
        vm.toggleTest();
        expect(input.getTracks()[0].stop).toHaveBeenCalledOnce();
        expect(input.getTracks()[0].onended).toBeNull();
        expect(processor.destroy).toHaveBeenCalledOnce();
        expect(playback.pause).toHaveBeenCalledOnce();
        expect(playback.srcObject).toBeNull();
        expect(playback.isConnected).toBe(false);
        onLevel(-10, true, -40);
        expect(vm.getSnapshot()).toMatchObject({
            testing: false,
            starting: false,
            levelDb: -100,
            voiceDetected: false,
        });
    });

    it("should cancel pending permission and immediately stop a late microphone stream", async () => {
        const pending = Promise.withResolvers<MediaStream>();
        mediaDevices.getUserMedia.mockReturnValueOnce(pending.promise);
        vm.toggleTest();
        expect(vm.getSnapshot().starting).toBe(true);
        vm.toggleTest();
        pending.resolve(input);
        await vi.waitFor(() => expect(input.getTracks()[0].stop).toHaveBeenCalledOnce());
        expect(mocks.createProcessor).not.toHaveBeenCalled();
        expect(vm.getSnapshot().testing).toBe(false);
    });

    it("should cancel initialization and ignore late processor callbacks on disposal", async () => {
        const pending = Promise.withResolvers<void>();
        processor.init.mockReturnValueOnce(pending.promise);
        vm.toggleTest();
        await vi.waitFor(() => expect(processor.init).toHaveBeenCalled());
        vm.dispose();
        pending.resolve();
        onLevel(-5, true, -30);
        await Promise.resolve();
        expect(processor.destroy).toHaveBeenCalledOnce();
        expect(input.getTracks()[0].stop).toHaveBeenCalledOnce();
        expect(playback.play).not.toHaveBeenCalled();
        expect(watchers.size).toBe(0);
        expect(vm.getSnapshot().levelDb).toBe(-100);
    });

    it.each(["NotAllowedError", "NotFoundError", "NotReadableError"])(
        "should report %s and allow retry",
        async (name) => {
            mediaDevices.getUserMedia.mockRejectedValueOnce(new DOMException("Capture failed", name));
            vm.toggleTest();
            await vi.waitFor(() => expect(vm.getSnapshot().error).toBeTruthy());
            expect(vm.getSnapshot()).toMatchObject({ testing: false, starting: false });
            expect(mocks.createProcessor).not.toHaveBeenCalled();
            await startTest();
            expect(vm.getSnapshot().error).toBeNull();
        },
    );

    it.each(["processing", "routing", "playback"])("should release capture on %s failure", async (failure) => {
        if (failure === "processing") processor.processedTrack = undefined;
        if (failure === "routing") vi.mocked(playback.setSinkId).mockRejectedValueOnce(new Error("Missing output"));
        if (failure === "playback") vi.mocked(playback.play).mockRejectedValueOnce(new Error("Playback blocked"));
        vm.toggleTest();
        await vi.waitFor(() => expect(vm.getSnapshot().error).toBeTruthy());
        expect(input.getTracks()[0].stop).toHaveBeenCalledOnce();
        expect(processor.destroy).toHaveBeenCalledOnce();
        expect(playback.isConnected).toBe(false);
    });

    it("should save clamped settings and adjust playback without reacquiring the microphone", async () => {
        await startTest();
        vm.setInputVolume(250);
        vm.setTestVolume(25);
        vm.setAutomaticSensitivity(false);
        vm.setSensitivityDb(-35);
        expect(vm.getSnapshot()).toMatchObject({
            inputVolume: 200,
            testVolume: 25,
            automaticSensitivity: false,
            sensitivityDb: -35,
            effectiveThresholdDb: -35,
        });
        expect(playback.volume).toBe(0.25);
        expect(mocks.setValue).toHaveBeenCalledWith("webrtc_audio_inputVolume", null, SettingLevel.DEVICE, 200);
        expect(mocks.setValue).toHaveBeenCalledWith("webrtc_audio_sensitivity", null, SettingLevel.DEVICE, -35);
        expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
        vm.setInputVolume(NaN);
        vm.setTestVolume(Infinity);
        vm.setSensitivityDb(NaN);
        expect(vm.getSnapshot()).toMatchObject({ inputVolume: 100, testVolume: 50, sensitivityDb: -50 });
    });

    it("should restore external preferences and a manual threshold while idle", () => {
        changeSetting("webrtc_audio_automaticSensitivity", false);
        changeSetting("webrtc_audio_sensitivity", -65);
        changeSetting("webrtc_audio_microphoneTestVolume", 20);
        expect(vm.getSnapshot()).toMatchObject({ testVolume: 20, sensitivityDb: -65, effectiveThresholdDb: -65 });
        expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    });

    it("should restart an active preview when changing microphone", async () => {
        await startTest();
        const next = makeStream();
        mediaDevices.getUserMedia.mockResolvedValueOnce(next);
        vm.setMicrophone("other-mic");
        await vi.waitFor(() => expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
        expect(input.getTracks()[0].stop).toHaveBeenCalledOnce();
        expect(mocks.setDevice).toHaveBeenCalledWith("other-mic", "audioinput");
        expect(mediaDevices.getUserMedia).toHaveBeenLastCalledWith(
            expect.objectContaining({
                audio: expect.objectContaining({ deviceId: { exact: "other-mic" } }),
            }),
        );
    });

    it("should not restart after settings closes during a microphone change", async () => {
        await startTest();
        const pending = Promise.withResolvers<void>();
        mocks.setDevice.mockReturnValueOnce(pending.promise);
        vm.setMicrophone("other-mic");
        vm.dispose();
        pending.resolve();
        await Promise.resolve();
        expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    });

    it("should route an active test to a new output", async () => {
        await startTest();
        vm.setSpeaker("speakers");
        expect(mocks.setDevice).toHaveBeenCalledWith("speakers", "audiooutput");
        expect(playback.setSinkId).toHaveBeenLastCalledWith("speakers");
        expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    });

    it("should ignore a stale output routing error after a new preview starts", async () => {
        await startTest();
        const pending = Promise.withResolvers<void>();
        vi.mocked(playback.setSinkId).mockReturnValueOnce(pending.promise);
        vm.setSpeaker("speakers");
        vm.toggleTest();
        // A subsequent test uses a different audio element.
        const previousPlayback = playback;
        playback = document.createElement("audio");
        playback.play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
        playback.pause = vi.fn();
        await startTest();
        pending.reject(new Error("Previous route failed"));
        await Promise.resolve();
        expect(previousPlayback.isConnected).toBe(false);
        expect(vm.getSnapshot()).toMatchObject({ testing: true, error: null });
    });

    it("should stop and announce a disconnected microphone", async () => {
        await startTest();
        input.getAudioTracks()[0].onended?.(new Event("ended"));
        expect(vm.getSnapshot()).toMatchObject({ testing: false, starting: false });
        expect(vm.getSnapshot().error).toContain("disconnected");
    });

    it("should ignore an ended event queued by the previous microphone", async () => {
        await startTest();
        const onEnded = input.getAudioTracks()[0].onended!;
        vm.toggleTest();
        const next = makeStream();
        mediaDevices.getUserMedia.mockResolvedValueOnce(next);
        await startTest();
        onEnded.call(input.getAudioTracks()[0], new Event("ended"));
        expect(vm.getSnapshot()).toMatchObject({ testing: true, error: null });
        expect(next.getTracks()[0].stop).not.toHaveBeenCalled();
    });

    it("should refresh device choices on hotplug and release audio on page hide", async () => {
        await startTest();
        mediaDevices.enumerateDevices.mockResolvedValueOnce([]);
        mediaDevices.dispatchEvent(new Event("devicechange"));
        await vi.waitFor(() => expect(vm.getSnapshot().microphones).toHaveLength(1));
        window.dispatchEvent(new Event("pagehide"));
        expect(vm.getSnapshot().testing).toBe(false);
        expect(input.getTracks()[0].stop).toHaveBeenCalledOnce();
    });

    it("should restart capture with current browser processing settings", async () => {
        await startTest();
        changeSetting("webrtc_audio_echoCancellation", false);
        await vi.waitFor(() => expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
        expect(input.getTracks()[0].stop).toHaveBeenCalledOnce();
    });
});
