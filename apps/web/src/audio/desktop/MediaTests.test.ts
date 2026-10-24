/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CameraTest } from "./CameraTest";
import { MicrophoneTest, mediaTestError } from "./MicrophoneTest";

import MediaDeviceHandler from "../../MediaDeviceHandler";
import SettingsStore from "../../settings/SettingsStore";

vi.mock("./microphoneGateWorkletFactory", () => ({ loadMicrophoneGateWorklet: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./denoiser/loadDenoiserModule", () => ({ loadDenoiserModule: vi.fn().mockResolvedValue({ compiled: true }) }));

function fakeStream(kind: "audio" | "video"): { stream: MediaStream; track: { stop: ReturnType<typeof vi.fn> } } {
    const track = { stop: vi.fn(), kind };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    return { stream, track };
}

describe("mediaTestError", () => {
    it("tells a refusal from a missing device", () => {
        expect(mediaTestError(new DOMException("no", "NotAllowedError"))).toBe("denied");
        expect(mediaTestError(new DOMException("no", "SecurityError"))).toBe("denied");
        expect(mediaTestError(new DOMException("none", "NotFoundError"))).toBe("unavailable");
        expect(mediaTestError("odd")).toBe("unavailable");
    });
});

describe("MicrophoneTest", () => {
    let getUserMedia: ReturnType<typeof vi.fn>;
    let micTrack: { stop: ReturnType<typeof vi.fn> };
    let outputTrack: { stop: ReturnType<typeof vi.fn> };
    let port: {
        onmessage: ((event: unknown) => void) | null;
        postMessage: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };
    let close: ReturnType<typeof vi.fn>;
    let play: ReturnType<typeof vi.fn>;
    let pause: ReturnType<typeof vi.fn>;
    let audio: { volume: number; srcObject: unknown; setSinkId: ReturnType<typeof vi.fn> };
    let values: Record<string, unknown>;
    let nodeOptions: AudioWorkletNodeOptions | undefined;

    beforeEach(() => {
        const mic = fakeStream("audio");
        micTrack = mic.track;
        getUserMedia = vi.fn().mockResolvedValue(mic.stream);
        vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
        outputTrack = { stop: vi.fn() };
        port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
        vi.stubGlobal(
            "AudioWorkletNode",
            class {
                public port = port;
                public connect = vi.fn();
                public disconnect = vi.fn();
                public constructor(_context: unknown, _name: string, options: AudioWorkletNodeOptions) {
                    nodeOptions = options;
                }
            },
        );
        close = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal(
            "AudioContext",
            class {
                public sampleRate = 48000;
                public close = close;
                public createMediaStreamSource = (): unknown => ({ connect: vi.fn(), disconnect: vi.fn() });
                public createMediaStreamDestination = (): unknown => ({
                    stream: { getAudioTracks: () => [outputTrack] },
                });
            },
        );
        vi.stubGlobal(
            "MediaStream",
            class {
                public constructor(public readonly tracks: unknown[]) {}
            },
        );
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
        vi.stubGlobal(
            "Audio",
            class {
                public volume = 1;
                public srcObject: unknown = null;
                public setSinkId = vi.fn().mockResolvedValue(undefined);
                public play = play;
                public pause = pause;
                public constructor() {
                    audio = this as never;
                }
            },
        );
        vi.spyOn(MediaDeviceHandler, "getAudioInput").mockReturnValue("mic-2");
        vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("speaker-2");
        vi.spyOn(MediaDeviceHandler, "getAudioEchoCancellation").mockReturnValue(false);
        vi.spyOn(MediaDeviceHandler, "getAudioAutoGainControl").mockReturnValue(false);
        values = {
            desktopMicrophoneVolume: 50,
            desktopSpeakerVolume: 40,
            desktopInputProfile: "custom",
            desktopNoiseSuppression: "standard",
            desktopNoiseSuppressionStrength: 100,
            desktopVoiceDetection: true,
            desktopInputSensitivityAuto: false,
            desktopInputSensitivity: -40,
            desktopInputMode: "push_to_talk",
            desktopPushToTalkKey: "KeyV",
        };
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => values[name] as never);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("opens the chosen microphone with the processing settings and plays it on the chosen speaker", async () => {
        const test = new MicrophoneTest(vi.fn());
        await test.start();
        expect(getUserMedia).toHaveBeenCalledWith({
            audio: {
                deviceId: { exact: "mic-2" },
                echoCancellation: false,
                autoGainControl: false,
                noiseSuppression: true,
            },
        });
        expect(audio.setSinkId).toHaveBeenCalledWith("speaker-2");
        expect(audio.volume).toBeCloseTo(0.4);
        expect(play).toHaveBeenCalled();
        expect(test.active).toBe(true);
    });

    it("lets you hear enhanced noise suppression and says when it stops working", async () => {
        values.desktopNoiseSuppression = "enhanced";
        values.desktopNoiseSuppressionStrength = 70;
        const onDenoiserStatus = vi.fn();
        const test = new MicrophoneTest(vi.fn(), onDenoiserStatus);
        await test.start();
        // The browser's suppression would only get in the model's way.
        expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ noiseSuppression: false }) });
        expect(nodeOptions?.processorOptions).toEqual(
            expect.objectContaining({
                config: expect.objectContaining({ noiseSuppression: 70, voiceDetection: true, pushToTalk: false }),
                denoiserModule: { compiled: true },
            }),
        );
        port.onmessage!({ data: { denoiser: "overloaded" } });
        expect(onDenoiserStatus).toHaveBeenCalledWith("overloaded");
    });

    it("reports the level and applies the volume and sensitivity, ignoring push to talk", async () => {
        const onLevel = vi.fn();
        const test = new MicrophoneTest(onLevel);
        await test.start();
        // The local playback test ignores PTT and forwards worklet metering to the view.
        port.onmessage!({ data: { level: -30, open: true } });
        expect(onLevel).toHaveBeenLastCalledWith(-30, true);
        expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ pushToTalkActive: true }));
    });

    it("follows changed settings while running", async () => {
        const test = new MicrophoneTest(vi.fn());
        await test.start();
        const changed: Record<string, unknown> = {
            desktopSpeakerVolume: 10,
            desktopMicrophoneVolume: 100,
            desktopInputProfile: "studio",
        };
        vi.mocked(SettingsStore.getValue).mockImplementation((name) => changed[name] as never);
        test.update();
        expect(audio.volume).toBeCloseTo(0.1);
    });

    it("closes everything it opened when stopped", async () => {
        const test = new MicrophoneTest(vi.fn());
        await test.start();
        test.stop();
        expect(micTrack.stop).toHaveBeenCalled();
        expect(outputTrack.stop).toHaveBeenCalled();
        expect(pause).toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
        expect(audio.srcObject).toBeNull();
        expect(test.active).toBe(false);
        // Stopping twice is harmless.
        expect(() => test.stop()).not.toThrow();
    });

    it("does not leave a microphone open when stopped while the permission prompt is showing", async () => {
        let resolve!: (stream: MediaStream) => void;
        getUserMedia.mockReturnValue(new Promise<MediaStream>((r) => (resolve = r)));
        const test = new MicrophoneTest(vi.fn());
        const started = test.start();
        test.stop();
        resolve(fakeStream("audio").stream);
        await started;
        expect(test.active).toBe(false);
    });

    it("reports a refusal and leaves nothing open", async () => {
        getUserMedia.mockRejectedValue(new DOMException("no", "NotAllowedError"));
        const test = new MicrophoneTest(vi.fn());
        await expect(test.start()).rejects.toThrow();
        expect(test.active).toBe(false);
    });

    it("ignores a second start while running", async () => {
        const test = new MicrophoneTest(vi.fn());
        await test.start();
        await test.start();
        expect(getUserMedia).toHaveBeenCalledOnce();
    });
});

describe("CameraTest", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("opens the chosen camera and stops its tracks when stopped", async () => {
        const camera = fakeStream("video");
        const getUserMedia = vi.fn().mockResolvedValue(camera.stream);
        vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
        vi.spyOn(MediaDeviceHandler, "getVideoInput").mockReturnValue("cam-1");
        const test = new CameraTest();
        await expect(test.start()).resolves.toBe(camera.stream);
        expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: "cam-1" } } });
        expect(test.active).toBe(true);
        test.stop();
        expect(camera.track.stop).toHaveBeenCalled();
        expect(test.active).toBe(false);
    });

    it("uses any camera for the system default", async () => {
        const getUserMedia = vi.fn().mockResolvedValue(fakeStream("video").stream);
        vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
        vi.spyOn(MediaDeviceHandler, "getVideoInput").mockReturnValue("default");
        await new CameraTest().start();
        expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: undefined } });
    });

    it("closes a camera that opens after the test was stopped", async () => {
        const camera = fakeStream("video");
        let resolve!: (stream: MediaStream) => void;
        const getUserMedia = vi.fn().mockReturnValue(new Promise<MediaStream>((r) => (resolve = r)));
        vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
        vi.spyOn(MediaDeviceHandler, "getVideoInput").mockReturnValue("");
        const test = new CameraTest();
        const started = test.start();
        test.stop();
        resolve(camera.stream);
        await expect(started).resolves.toBeNull();
        expect(camera.track.stop).toHaveBeenCalled();
        expect(test.active).toBe(false);
    });

    it("passes on a refusal", async () => {
        const getUserMedia = vi.fn().mockRejectedValue(new DOMException("no", "NotAllowedError"));
        vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
        vi.spyOn(MediaDeviceHandler, "getVideoInput").mockReturnValue("");
        await expect(new CameraTest().start()).rejects.toThrow();
    });
});
