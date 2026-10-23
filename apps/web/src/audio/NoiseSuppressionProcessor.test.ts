/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type NoiseSuppressionProcessor } from "./NoiseSuppressionProcessor";

const settings = vi.hoisted(() => ({
    getValue: vi.fn<(name: string) => boolean | number>(),
    watchSetting: vi.fn<(name: string, roomId: null, callback: () => void) => string>(),
    unwatchSetting: vi.fn<(watcher: string | undefined) => void>(),
}));

vi.mock("../settings/SettingsStore", () => ({ default: settings }));
vi.mock("./voiceGateWorkletFactory", () => ({
    loadVoiceGateWorklet: (context: AudioContext) => context.audioWorklet.addModule("/gate.js"),
}));
vi.mock("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url", () => ({ default: "/rnnoiseWorklet.js" }));
vi.mock("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url", () => ({ default: "/rnnoise.wasm" }));
vi.mock("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url", () => ({ default: "/rnnoise_simd.wasm" }));

function createTrack(id: string): MediaStreamTrack {
    return { id, kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
}

function createStream(tracks: MediaStreamTrack[]) {
    return { getTracks: () => tracks, getAudioTracks: () => tracks };
}

function createNode() {
    return { connect: vi.fn<(destination: unknown) => void>(), disconnect: vi.fn<() => void>() };
}

function createContext() {
    const output = createTrack("processed microphone");
    return {
        state: "running" as AudioContextState,
        destination: createNode(),
        source: createNode(),
        output,
        outputNode: { ...createNode(), stream: createStream([output]) },
        audioWorklet: { addModule: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined) },
        createMediaStreamSource: vi.fn<(stream: MediaStream) => unknown>(),
        createMediaStreamDestination: vi.fn<() => unknown>(),
        resume: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
}

describe("NoiseSuppressionProcessor", () => {
    let processor: NoiseSuppressionProcessor;
    let input: MediaStreamTrack;
    let context: ReturnType<typeof createContext>;
    let denoiser: ReturnType<typeof createNode> & {
        destroy: ReturnType<typeof vi.fn>;
        onprocessorerror: (() => void) | null;
        ready?: Promise<void>;
    };
    let createAudioContext: ReturnType<typeof vi.fn>;
    let createMediaStream: ReturnType<typeof vi.fn>;
    let createDenoiser: ReturnType<typeof vi.fn>;
    let getUserMedia: ReturnType<typeof vi.fn>;
    let loadRnnoise: ReturnType<
        typeof vi.fn<(options: { url: string; simdUrl: string }, init?: RequestInit) => Promise<ArrayBuffer>>
    >;
    let watchers: Map<string, () => void>;
    let values: Record<string, boolean | number>;
    let gate: ReturnType<typeof createNode> & {
        port: {
            postMessage: ReturnType<typeof vi.fn>;
            close: ReturnType<typeof vi.fn>;
            onmessage: ((event: MessageEvent) => void) | null;
        };
    };
    const wasmBinary = new ArrayBuffer(8);

    function setEnabled(enabled: boolean): void {
        values.webrtc_audio_noiseSuppression = enabled;
        for (const [name, , callback] of settings.watchSetting.mock.calls) {
            if (name === "webrtc_audio_noiseSuppression") callback();
        }
    }

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        input = createTrack("existing microphone");
        context = createContext();
        context.createMediaStreamSource.mockReturnValue(context.source);
        context.createMediaStreamDestination.mockReturnValue(context.outputNode);
        denoiser = { ...createNode(), destroy: vi.fn(), onprocessorerror: null };
        createAudioContext = vi.fn(function () {
            return context;
        });
        createMediaStream = vi.fn(function (tracks: MediaStreamTrack[]) {
            return createStream(tracks);
        });
        createDenoiser = vi.fn(function () {
            return denoiser;
        });
        loadRnnoise = vi.fn<typeof loadRnnoise>().mockResolvedValue(wasmBinary);
        getUserMedia = vi.fn();
        watchers = new Map();
        values = {
            webrtc_audio_noiseSuppression: true,
            webrtc_audio_inputVolume: 100,
            webrtc_audio_automaticSensitivity: true,
            webrtc_audio_sensitivity: -50,
        };
        settings.getValue.mockImplementation((name) => values[name]);
        gate = { ...createNode(), port: { postMessage: vi.fn(), close: vi.fn(), onmessage: null } };
        vi.stubGlobal(
            "AudioWorkletNode",
            vi.fn(function () {
                return gate;
            }),
        );
        settings.watchSetting.mockImplementation((_name, _roomId, callback) => {
            const id = `watcher-${settings.watchSetting.mock.calls.length}`;
            watchers.set(id, callback);
            return id;
        });
        settings.unwatchSetting.mockImplementation((id) => {
            if (id) watchers.delete(id);
        });
        vi.stubGlobal("AudioContext", createAudioContext);
        vi.stubGlobal("MediaStream", createMediaStream);
        vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
        vi.doMock("@sapphi-red/web-noise-suppressor", () => ({
            RnnoiseWorkletNode: createDenoiser,
            loadRnnoise,
        }));
        const { NoiseSuppressionProcessor } = await import("./NoiseSuppressionProcessor");
        processor = new NoiseSuppressionProcessor();
    });

    afterEach(async () => {
        await processor.destroy();
        vi.doUnmock("@sapphi-red/web-noise-suppressor");
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("should process the existing microphone at 48 kHz without playing it through speakers", async () => {
        await processor.init({ track: input });

        expect(createAudioContext).toHaveBeenCalledWith({ sampleRate: 48000, latencyHint: "interactive" });
        expect(createMediaStream).toHaveBeenCalledWith([input]);
        expect(context.createMediaStreamSource).toHaveBeenCalledWith(createMediaStream.mock.results[0].value);
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(loadRnnoise).toHaveBeenCalledWith(
            { url: "/rnnoise.wasm", simdUrl: "/rnnoise_simd.wasm" },
            { signal: expect.any(AbortSignal) },
        );
        expect(context.audioWorklet.addModule).toHaveBeenCalledWith("/rnnoiseWorklet.js");
        expect(createDenoiser).toHaveBeenCalledWith(context, { wasmBinary, maxChannels: 1 });
        expect(processor.processedTrack).toBe(context.output);
        expect(processor.processedTrack).not.toBe(input);
        expect(context.source.connect).toHaveBeenCalledExactlyOnceWith(denoiser);
        expect(denoiser.connect).toHaveBeenCalledExactlyOnceWith(gate);
        expect(gate.connect).toHaveBeenCalledExactlyOnceWith(context.outputNode);
        expect(context.outputNode.connect).not.toHaveBeenCalled();
        expect(context.source.connect).not.toHaveBeenCalledWith(context.destination);
        expect(denoiser.connect).not.toHaveBeenCalledWith(context.destination);
        expect(settings.watchSetting).toHaveBeenCalledWith("webrtc_audio_noiseSuppression", null, expect.any(Function));
    });

    it("should bypass suppression when disabled and toggle routing without replacing the output track", async () => {
        setEnabled(false);
        await processor.init({ track: input });

        expect(context.source.connect).toHaveBeenCalledExactlyOnceWith(gate);
        expect(settings.getValue).toHaveBeenCalledWith("webrtc_audio_noiseSuppression");

        setEnabled(true);
        expect(context.source.connect).toHaveBeenLastCalledWith(denoiser);
        setEnabled(false);
        expect(context.source.connect).toHaveBeenLastCalledWith(gate);
        expect(context.source.disconnect).toHaveBeenCalledTimes(3);
        expect(processor.processedTrack).toBe(context.output);
        expect(createAudioContext).toHaveBeenCalledTimes(1);
        expect(createDenoiser).toHaveBeenCalledTimes(1);
    });

    it("should send sanitized live device settings to the audio thread", async () => {
        await processor.init({ track: input });
        values.webrtc_audio_inputVolume = 250;
        values.webrtc_audio_automaticSensitivity = false;
        values.webrtc_audio_sensitivity = NaN;
        const changed = settings.watchSetting.mock.calls.find(([name]) => name === "webrtc_audio_inputVolume")![2];
        changed();
        expect(gate.port.postMessage).toHaveBeenLastCalledWith({
            inputVolume: 200,
            automaticSensitivity: false,
            sensitivity: -50,
        });
        expect(context.source.disconnect).toHaveBeenCalledOnce();
        expect(processor.processedTrack).toBe(context.output);
    });

    it("should forward worklet levels and ignore queued levels after destruction", async () => {
        const callback = vi.fn();
        const { NoiseSuppressionProcessor } = await import("./NoiseSuppressionProcessor");
        processor = new NoiseSuppressionProcessor(callback);
        await processor.init({ track: input });
        const message = gate.port.onmessage!;
        const event = { data: { levelDb: -35, voiceDetected: true, thresholdDb: -45 } } as MessageEvent;
        message(event);
        expect(callback).toHaveBeenCalledExactlyOnceWith(-35, true, -45);
        await processor.destroy();
        message(event);
        expect(callback).toHaveBeenCalledOnce();
        expect(gate.port.postMessage).toHaveBeenLastCalledWith({ destroy: true });
        expect(gate.port.close).toHaveBeenCalledOnce();
        expect(gate.disconnect).toHaveBeenCalledOnce();
        expect(gate.port.onmessage).toBeNull();
    });

    it("should preserve the original track when AudioContext construction fails", async () => {
        createAudioContext.mockImplementationOnce(() => {
            throw new Error("Audio unavailable");
        });
        await expect(processor.init({ track: input })).resolves.toBeUndefined();
        expect(processor.processedTrack).toBeUndefined();
        expect(input.stop).not.toHaveBeenCalled();
        expect(settings.watchSetting).not.toHaveBeenCalled();
    });

    it.each(["failure", "timeout"])("should release the graph after gate loading %s", async (failure) => {
        vi.useFakeTimers();
        context.audioWorklet.addModule.mockImplementation(() =>
            failure === "failure" ? Promise.reject(new Error("Gate unavailable")) : new Promise(() => {}),
        );
        const initializing = processor.init({ track: input });
        await vi.advanceTimersByTimeAsync(10000);
        await initializing;
        expect(processor.processedTrack).toBeUndefined();
        expect(context.close).toHaveBeenCalledOnce();
        expect(loadRnnoise).not.toHaveBeenCalled();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should release the previous graph and use the replacement microphone after a device change", async () => {
        await processor.init({ track: input });
        const previousContext = context;
        const previousDenoiser = denoiser;
        const replacement = createTrack("replacement microphone");
        context = createContext();
        context.createMediaStreamSource.mockReturnValue(context.source);
        context.createMediaStreamDestination.mockReturnValue(context.outputNode);
        denoiser = { ...createNode(), destroy: vi.fn(), onprocessorerror: null };

        await processor.restart({ track: replacement });

        expect(previousContext.source.disconnect).toHaveBeenCalledTimes(2);
        expect(previousDenoiser.disconnect).toHaveBeenCalledOnce();
        expect(previousDenoiser.destroy).toHaveBeenCalledOnce();
        expect(previousContext.output.stop).toHaveBeenCalledOnce();
        expect(previousContext.close).toHaveBeenCalledOnce();
        expect(settings.unwatchSetting).toHaveBeenCalledWith("watcher-1");
        expect(createMediaStream).toHaveBeenLastCalledWith([replacement]);
        expect(context.source.connect).toHaveBeenCalledExactlyOnceWith(denoiser);
        expect(processor.processedTrack).toBe(context.output);
        expect(watchers.size).toBe(4);
        expect(input.stop).not.toHaveBeenCalled();
        expect(replacement.stop).not.toHaveBeenCalled();
    });

    it("should stop only its output, remove the settings listener, and close its context on destroy", async () => {
        await processor.init({ track: input });
        await processor.destroy();
        await processor.destroy();
        const connections = context.source.connect.mock.calls.length;
        setEnabled(false);

        expect(context.output.stop).toHaveBeenCalledOnce();
        expect(input.stop).not.toHaveBeenCalled();
        expect(denoiser.disconnect).toHaveBeenCalledOnce();
        expect(denoiser.destroy).toHaveBeenCalledOnce();
        expect(context.outputNode.disconnect).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalledOnce();
        expect(settings.unwatchSetting).toHaveBeenCalledWith("watcher-1");
        expect(watchers.size).toBe(0);
        expect(context.source.connect).toHaveBeenCalledTimes(connections);
        expect(processor.processedTrack).toBeUndefined();
    });

    it("should ignore processor errors from a graph replaced by restart", async () => {
        await processor.init({ track: input });
        const previousError = denoiser.onprocessorerror!;
        context = createContext();
        context.createMediaStreamSource.mockReturnValue(context.source);
        context.createMediaStreamDestination.mockReturnValue(context.outputNode);
        denoiser = { ...createNode(), destroy: vi.fn(), onprocessorerror: null };
        await processor.restart({ track: createTrack("replacement microphone") });

        // A queued processorerror from the old worklet must not disable the replacement graph.
        previousError();

        expect(context.source.connect).toHaveBeenCalledExactlyOnceWith(denoiser);
        expect(watchers.size).toBe(4);
        expect(processor.processedTrack).toBe(context.output);
    });

    it.each(["wasm", "worklet"])("should retain gain and gate if loading the RNNoise %s fails", async (failure) => {
        if (failure === "wasm") loadRnnoise.mockRejectedValueOnce(new Error("WASM unavailable"));
        else
            context.audioWorklet.addModule.mockImplementation(async (url) => {
                if (url === "/rnnoiseWorklet.js") throw new Error("Worklet unavailable");
            });

        await expect(processor.init({ track: input })).resolves.toBeUndefined();

        expect(processor.processedTrack).toBe(context.output);
        expect(context.close).not.toHaveBeenCalled();
        expect(context.source.connect).toHaveBeenCalledWith(gate);
        expect(watchers.size).toBe(4);
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should retain gain and gate if the noise suppressor module cannot be imported", async () => {
        vi.doMock("@sapphi-red/web-noise-suppressor", () => {
            throw new Error("Module unavailable");
        });

        await expect(processor.init({ track: input })).resolves.toBeUndefined();

        expect(processor.processedTrack).toBe(context.output);
        expect(context.source.connect).toHaveBeenCalledWith(gate);
        expect(watchers.size).toBe(4);
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should wait for the model before publishing an output track", async () => {
        const pending = Promise.withResolvers<void>();
        denoiser.ready = pending.promise;
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(createDenoiser).toHaveBeenCalled());
        expect(processor.processedTrack).toBeUndefined();
        expect(settings.watchSetting).not.toHaveBeenCalled();
        pending.resolve();
        await initializing;
        expect(processor.processedTrack).toBe(context.output);
    });

    it("should retain gain and gate if the audio thread cannot initialize the model", async () => {
        const pending = Promise.withResolvers<void>();
        denoiser.ready = pending.promise;
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(createDenoiser).toHaveBeenCalled());
        pending.reject(new Error("Invalid model"));
        await initializing;
        expect(processor.processedTrack).toBe(context.output);
        expect(context.source.connect).toHaveBeenCalledWith(gate);
        expect(context.close).not.toHaveBeenCalled();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should discard a model that finishes initializing after hangup", async () => {
        const pending = Promise.withResolvers<void>();
        denoiser.ready = pending.promise;
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(createDenoiser).toHaveBeenCalled());
        await processor.destroy();
        pending.resolve();
        await initializing;
        expect(processor.processedTrack).toBeUndefined();
        expect(settings.watchSetting).not.toHaveBeenCalled();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it.each(["wasm", "worklet"])("should time out stalled %s loading and fall back", async (loading) => {
        vi.useFakeTimers();
        if (loading === "wasm") loadRnnoise.mockReturnValueOnce(new Promise(() => {}));
        else
            context.audioWorklet.addModule.mockImplementation((url) =>
                url === "/rnnoiseWorklet.js" ? new Promise(() => {}) : Promise.resolve(),
            );
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(context.audioWorklet.addModule).toHaveBeenCalled());
        await vi.waitFor(() => expect(loadRnnoise).toHaveBeenCalled());
        const signal = vi.mocked(loadRnnoise).mock.calls[0][1]?.signal;
        await vi.advanceTimersByTimeAsync(10000);
        await initializing;

        expect(signal?.aborted).toBe(true);
        expect(processor.processedTrack).toBe(context.output);
        expect(context.source.connect).toHaveBeenCalledWith(gate);
        expect(context.close).not.toHaveBeenCalled();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should release a pending initialization immediately on hangup", async () => {
        loadRnnoise.mockReturnValueOnce(new Promise(() => {}));
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(loadRnnoise).toHaveBeenCalled());
        const signal = loadRnnoise.mock.calls[0][1]?.signal;
        await processor.destroy();
        await initializing;
        expect(signal?.aborted).toBe(true);
        expect(processor.processedTrack).toBeUndefined();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should bypass a failed processor and prevent later settings changes from reconnecting it", async () => {
        await processor.init({ track: input });

        denoiser.onprocessorerror!();

        expect(context.source.connect).toHaveBeenLastCalledWith(gate);
        expect(watchers.size).toBe(4);
        setEnabled(false);
        setEnabled(true);
        expect(context.source.connect).toHaveBeenLastCalledWith(gate);
        expect(processor.processedTrack).toBe(context.output);
        expect(context.output.stop).not.toHaveBeenCalled();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it.each(["wasm", "worklet"])("should not create a stale graph after destroy while loading %s", async (loading) => {
        const pending = Promise.withResolvers<void>();
        if (loading === "wasm")
            loadRnnoise.mockImplementationOnce(async () => {
                await pending.promise;
                return wasmBinary;
            });
        else
            context.audioWorklet.addModule.mockImplementation((url) =>
                url === "/rnnoiseWorklet.js" ? pending.promise : Promise.resolve(),
            );

        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(loadRnnoise).toHaveBeenCalled());
        await vi.waitFor(() => expect(context.audioWorklet.addModule).toHaveBeenCalledWith("/rnnoiseWorklet.js"));
        await processor.destroy();
        pending.resolve();
        await initializing;

        expect(context.close).toHaveBeenCalledOnce();
        expect(context.createMediaStreamSource).not.toHaveBeenCalled();
        expect(createDenoiser).not.toHaveBeenCalled();
        expect(settings.watchSetting).not.toHaveBeenCalled();
        expect(processor.processedTrack).toBeUndefined();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should discard an import that completes after destroy", async () => {
        const pending = Promise.withResolvers<void>();
        vi.doMock("@sapphi-red/web-noise-suppressor", async () => {
            await pending.promise;
            return { RnnoiseWorkletNode: createDenoiser, loadRnnoise };
        });

        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(gate.port.onmessage).not.toBeNull());
        await processor.destroy();
        pending.resolve();
        await initializing;

        expect(context.close).toHaveBeenCalledOnce();
        expect(loadRnnoise).not.toHaveBeenCalled();
        expect(processor.processedTrack).toBeUndefined();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should not recreate a microphone graph when hanging up during a device change", async () => {
        await processor.init({ track: input });
        const pending = Promise.withResolvers<void>();
        context.close.mockReturnValueOnce(pending.promise);
        const restarting = processor.restart({ track: createTrack("replacement microphone") });
        await processor.destroy();
        pending.resolve();
        await restarting;

        expect(createAudioContext).toHaveBeenCalledOnce();
        expect(processor.processedTrack).toBeUndefined();
        expect(watchers.size).toBe(0);
    });

    it.each(["resolve", "reject"])(
        "should preserve the replacement graph when a previous initialization later ends with %s",
        async (completion) => {
            const pending = Promise.withResolvers<ArrayBuffer>();
            loadRnnoise.mockReturnValueOnce(pending.promise);
            const initializing = processor.init({ track: input });
            await vi.waitFor(() => expect(loadRnnoise).toHaveBeenCalled());
            const previousContext = context;
            context = createContext();
            context.createMediaStreamSource.mockReturnValue(context.source);
            context.createMediaStreamDestination.mockReturnValue(context.outputNode);
            await processor.restart({ track: createTrack("replacement microphone") });

            if (completion === "resolve") pending.resolve(wasmBinary);
            else pending.reject(new Error("Previous initialization failed"));
            await initializing;

            expect(previousContext.close).toHaveBeenCalledOnce();
            expect(previousContext.createMediaStreamSource).not.toHaveBeenCalled();
            expect(context.close).not.toHaveBeenCalled();
            expect(context.source.connect).toHaveBeenCalledExactlyOnceWith(denoiser);
            expect(createDenoiser).toHaveBeenCalledOnce();
            expect(processor.processedTrack).toBe(context.output);
            expect(watchers.size).toBe(4);
            expect(input.stop).not.toHaveBeenCalled();
        },
    );

    it("should resume a suspended context before connecting the microphone", async () => {
        context.state = "suspended";
        const pending = Promise.withResolvers<void>();
        context.resume.mockReturnValueOnce(pending.promise);
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(context.resume).toHaveBeenCalled());
        expect(context.createMediaStreamSource).not.toHaveBeenCalled();

        pending.resolve();
        await initializing;

        expect(processor.processedTrack).toBe(context.output);
        expect(context.source.connect).toHaveBeenCalledWith(denoiser);
    });

    it("should fall back when autoplay prevents the context from resuming", async () => {
        vi.useFakeTimers();
        context.state = "suspended";
        context.resume.mockReturnValueOnce(new Promise(() => {}));
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(context.resume).toHaveBeenCalled());

        await vi.advanceTimersByTimeAsync(2000);
        await initializing;

        expect(processor.processedTrack).toBeUndefined();
        expect(context.close).toHaveBeenCalledOnce();
        expect(context.createMediaStreamSource).not.toHaveBeenCalled();
        expect(input.stop).not.toHaveBeenCalled();
    });

    it("should not connect the microphone if destroy happens while the context is resuming", async () => {
        context.state = "suspended";
        const pending = Promise.withResolvers<void>();
        context.resume.mockReturnValueOnce(pending.promise);
        const initializing = processor.init({ track: input });
        await vi.waitFor(() => expect(context.resume).toHaveBeenCalled());

        await processor.destroy();
        pending.resolve();
        await initializing;

        expect(context.close).toHaveBeenCalledOnce();
        expect(context.createMediaStreamSource).not.toHaveBeenCalled();
        expect(processor.processedTrack).toBeUndefined();
        expect(watchers.size).toBe(0);
    });
});
