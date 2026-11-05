/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicrophoneProcessor } from "./MicrophoneProcessor";
import { loadMicrophoneGateWorklet } from "./microphoneGateWorkletFactory";
import { loadDenoiserModule } from "./denoiser/loadDenoiserModule";

vi.mock("./microphoneGateWorkletFactory", () => ({ loadMicrophoneGateWorklet: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./denoiser/loadDenoiserModule", () => ({ loadDenoiserModule: vi.fn() }));

interface FakeContext {
    options: AudioContextOptions;
    state: AudioContextState;
    source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    outputTrack: { stop: ReturnType<typeof vi.fn>; enabled: boolean };
    close: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    suspend: ReturnType<typeof vi.fn>;
}

/** Stands in for LiveKit's shared context, which the processor must leave alone. */
const sharedContext = {} as AudioContext;

describe("MicrophoneProcessor", () => {
    let nodes: Array<{
        port: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onmessage: unknown };
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        onprocessorerror?: () => void;
        options: AudioWorkletNodeOptions;
    }>;
    let contexts: FakeContext[];
    const config = { volume: 1, threshold: null, pushToTalk: false } as const;
    const track = (): MediaStreamTrack => ({ id: "mic", enabled: true }) as MediaStreamTrack;
    const denoiserModule = { compiled: true } as unknown as WebAssembly.Module;
    const init = (processor: MicrophoneProcessor, input = track()): Promise<void> =>
        processor.init({ kind: "audio", track: input, audioContext: sharedContext });

    beforeEach(() => {
        vi.mocked(loadMicrophoneGateWorklet).mockReset().mockResolvedValue(undefined);
        vi.mocked(loadDenoiserModule).mockReset().mockResolvedValue(denoiserModule);
        nodes = [];
        contexts = [];
        vi.stubGlobal(
            "AudioContext",
            class implements FakeContext {
                public state: AudioContextState = "running";
                public source = { connect: vi.fn(), disconnect: vi.fn() };
                public outputTrack = { stop: vi.fn(), enabled: true };
                public close = vi.fn(async () => {
                    this.state = "closed";
                });
                public suspend = vi.fn(async () => {
                    this.state = "suspended";
                });
                public resume = vi.fn(async () => {
                    this.state = "running";
                });
                public createMediaStreamSource = vi.fn().mockReturnValue(this.source);
                public createMediaStreamDestination = vi
                    .fn()
                    .mockReturnValue({ stream: { getAudioTracks: () => [this.outputTrack] } });
                public constructor(public readonly options: AudioContextOptions) {
                    contexts.push(this);
                }
            },
        );
        vi.stubGlobal(
            "MediaStream",
            class {
                public constructor(public readonly tracks: MediaStreamTrack[]) {}
            },
        );
        vi.stubGlobal(
            "AudioWorkletNode",
            class {
                public port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
                public connect = vi.fn();
                public disconnect = vi.fn();
                public constructor(
                    _context: AudioContext,
                    _name: string,
                    public options: AudioWorkletNodeOptions,
                ) {
                    nodes.push(this);
                }
            },
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("loads the audio-thread module before connecting capture, with the current hold state", async () => {
        const processor = new MicrophoneProcessor({ ...config, pushToTalk: true });
        processor.setPushToTalkActive(true);
        processor.setShortcutMuted(true);
        await init(processor);
        // A context of its own at the model's rate, so the call's playback never waits for the microphone.
        expect(contexts).toHaveLength(1);
        expect(contexts[0].options).toEqual({ sampleRate: 48000, latencyHint: "interactive" });
        expect(loadMicrophoneGateWorklet).toHaveBeenCalledWith(contexts[0]);
        expect(loadDenoiserModule).not.toHaveBeenCalled();
        expect(nodes[0].options.processorOptions).toEqual({
            config: { ...config, pushToTalk: true },
            pushToTalkActive: true,
            shortcutMuted: true,
            denoiserModule: undefined,
        });
        expect(contexts[0].source.connect).toHaveBeenCalledWith(nodes[0]);
        expect(processor.processedTrack).toBe(contexts[0].outputTrack);
    });

    it("starts noise suppression with the graph when it is wanted", async () => {
        const processor = new MicrophoneProcessor({ ...config, noiseSuppression: 80, voiceDetection: true });
        await init(processor);
        expect(nodes[0].options.processorOptions).toEqual(expect.objectContaining({ denoiserModule }));
    });

    it("sends noise suppression to a running graph once it is turned on", async () => {
        const processor = new MicrophoneProcessor(config);
        await init(processor);
        processor.setConfig({ ...config, noiseSuppression: 100 });
        await vi.waitFor(() => expect(nodes[0].port.postMessage).toHaveBeenCalledWith({ denoiserModule }));
        nodes[0].port.postMessage.mockClear();
        processor.setConfig({ ...config, noiseSuppression: 50 });
        await Promise.resolve();
        expect(nodes[0].port.postMessage).not.toHaveBeenCalledWith({ denoiserModule });
    });

    it("keeps the microphone working without noise suppression when it cannot be loaded", async () => {
        vi.mocked(loadDenoiserModule).mockRejectedValue(new Error("offline"));
        const processor = new MicrophoneProcessor({ ...config, noiseSuppression: 100 });
        processor.onDenoiserStatus = vi.fn();
        await init(processor);
        expect(processor.onDenoiserStatus).toHaveBeenCalledWith("failed");
        expect(nodes[0].options.processorOptions).toEqual(expect.objectContaining({ denoiserModule: undefined }));
        expect(processor.processedTrack).toBe(contexts[0].outputTrack);
    });

    it("passes on what the audio thread reports about noise suppression, from every connection", async () => {
        const root = new MicrophoneProcessor({ ...config, noiseSuppression: 100 });
        root.onDenoiserStatus = vi.fn();
        await init(root.createProcessor());
        (nodes[0].port.onmessage as (event: unknown) => void)({ data: { denoiser: "overloaded" } });
        expect(root.onDenoiserStatus).toHaveBeenCalledWith("overloaded");
    });

    it("sends complete state updates to every independent connection", async () => {
        const root = new MicrophoneProcessor(config);
        const a = root.createProcessor();
        const b = root.createProcessor();
        await init(a);
        await init(b);
        root.setPushToTalkActive(true);
        root.setShortcutMuted(true);
        root.setConfig({ ...config, volume: 0 });
        for (const node of nodes)
            expect(node.port.postMessage).toHaveBeenLastCalledWith({
                config: { ...config, volume: 0 },
                pushToTalkActive: true,
                shortcutMuted: true,
            });
        await a.destroy();
        const count = nodes[0].port.postMessage.mock.calls.length;
        root.setShortcutMuted(false);
        expect(nodes[0].port.postMessage).toHaveBeenCalledTimes(count);
        expect(nodes[1].port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ shortcutMuted: false }));
    });

    it("reports the audio thread meter without reading microphone samples on the UI thread", async () => {
        const processor = new MicrophoneProcessor(config);
        processor.onLevel = vi.fn();
        await init(processor);
        (nodes[0].port.onmessage as (event: unknown) => void)({ data: { level: -35, open: true, threshold: -48 } });
        expect(processor.onLevel).toHaveBeenCalledWith(-35, true, -48);
        expect(nodes[0].port.postMessage).toHaveBeenCalledWith({ reportLevel: true });
    });

    it("disables the meter for calls and follows changes to the meter subscription", async () => {
        const processor = new MicrophoneProcessor(config);
        await init(processor);
        expect(nodes[0].port.postMessage).toHaveBeenCalledWith({ reportLevel: false });
        processor.onLevel = vi.fn();
        expect(nodes[0].port.postMessage).toHaveBeenLastCalledWith({ reportLevel: true });
        processor.onLevel = undefined;
        expect(nodes[0].port.postMessage).toHaveBeenLastCalledWith({ reportLevel: false });
    });

    it("fails initialization instead of returning an unprocessed microphone", async () => {
        vi.mocked(loadMicrophoneGateWorklet).mockRejectedValue(new Error("module blocked"));
        const processor = new MicrophoneProcessor(config);
        await expect(init(processor)).rejects.toThrow("module blocked");
        expect(processor.processedTrack).toBeUndefined();
        expect(nodes).toHaveLength(0);
        expect(contexts[0].close).toHaveBeenCalled();
    });

    it("cannot finish initialization after disposal", async () => {
        let resolve!: () => void;
        vi.mocked(loadMicrophoneGateWorklet).mockReturnValue(
            new Promise<void>((r) => {
                resolve = r;
            }),
        );
        const processor = new MicrophoneProcessor(config);
        const pending = init(processor);
        await processor.destroy();
        resolve();
        await expect(pending).rejects.toThrow("cancelled");
        expect(processor.processedTrack).toBeUndefined();
    });

    it("silences both the processed output and source on a worklet crash", async () => {
        const input = track();
        const processor = new MicrophoneProcessor(config);
        await init(processor, input);
        nodes[0].onprocessorerror!();
        expect(contexts[0].outputTrack.enabled).toBe(false);
        expect(input.enabled).toBe(false);
    });

    it("restarts one graph without stopping another connection, then disposes all children", async () => {
        const root = new MicrophoneProcessor(config);
        const a = root.createProcessor();
        const b = root.createProcessor();
        await init(a);
        await init(b);
        const [first, second] = contexts;
        await a.restart({ kind: "audio", track: track(), audioContext: sharedContext });
        expect(first.outputTrack.stop).toHaveBeenCalledOnce();
        expect(first.close).toHaveBeenCalledOnce();
        expect(second.outputTrack.stop).not.toHaveBeenCalled();
        await root.destroy();
        expect(second.outputTrack.stop).toHaveBeenCalledOnce();
        expect(second.close).toHaveBeenCalledOnce();
        expect(nodes[0].port.onmessage).toBeNull();
        expect(nodes[0].port.close).toHaveBeenCalled();
        await expect(root.destroy()).resolves.toBeUndefined();
    });
    const ready = async (count = 1): Promise<void> => {
        await vi.waitFor(() => {
            expect(nodes).toHaveLength(count);
            expect(nodes.at(-1)?.port.onmessage).toBeTypeOf("function");
        });
        (nodes.at(-1)!.port.onmessage as (event: unknown) => void)({ data: { ready: true } });
        await Promise.resolve();
        await Promise.resolve();
    };

    it("prepares without capturing and gives only one connection the suspended graph", async () => {
        const root = new MicrophoneProcessor(config);
        root.prepare();
        await ready();
        expect(contexts[0].suspend).toHaveBeenCalledOnce();
        expect(contexts[0].source.connect).not.toHaveBeenCalled();
        expect(nodes[0].options.processorOptions.shortcutMuted).toBe(true);
        root.setShortcutMuted(true);
        const a = root.createProcessor();
        await init(a);
        expect(contexts).toHaveLength(1);
        expect(contexts[0].resume).toHaveBeenCalledOnce();
        expect(nodes[0].port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ shortcutMuted: true }));
        expect(nodes[0].port.postMessage.mock.invocationCallOrder[0]).toBeLessThan(
            contexts[0].source.connect.mock.invocationCallOrder[0],
        );
        await init(root.createProcessor());
        expect(contexts).toHaveLength(2);
        root.clearPrepared();
        await root.destroy();
    });

    it("discards an incompatible prepared model and prepares the new settings", async () => {
        const root = new MicrophoneProcessor(config);
        root.prepare();
        await ready();
        root.setConfig({ ...config, noiseSuppression: 80 });
        expect(contexts[0].close).toHaveBeenCalledOnce();
        await ready(2);
        const child = root.createProcessor();
        await init(child);
        expect(nodes[1].options.processorOptions.denoiserModule).toBe(denoiserModule);
        root.clearPrepared();
        await root.destroy();
    });

    it.each([
        ["turned on", config, { ...config, noiseSuppression: 80 }, denoiserModule],
        ["turned off", { ...config, noiseSuppression: 80 }, config, undefined],
    ])(
        "builds a fresh graph when noise suppression is %s while a claimed graph is still preparing",
        async (_, before, after, expectedModule) => {
            const root = new MicrophoneProcessor(before);
            root.prepare();
            await vi.waitFor(() => expect(nodes).toHaveLength(1));
            const child = root.createProcessor();
            const pending = init(child);
            root.setConfig(after);
            (nodes[0].port.onmessage as (event: unknown) => void)({ data: { ready: true } });
            await pending;

            expect(contexts[0].close).toHaveBeenCalled();
            expect(nodes).toHaveLength(2);
            expect(nodes[1].options.processorOptions.denoiserModule).toBe(expectedModule);
            expect(contexts[1].source.connect).toHaveBeenCalledWith(nodes[1]);
            root.clearPrepared();
            await root.destroy();
        },
    );

    it("cancels preparation during model loading and during the worklet handshake", async () => {
        const root = new MicrophoneProcessor(config);
        root.prepare();
        await vi.waitFor(() => expect(nodes).toHaveLength(1));
        const child = root.createProcessor();
        const pending = init(child);
        root.clearPrepared();
        await child.destroy();
        await expect(pending).rejects.toThrow("cancelled");
        expect(contexts[0].close).toHaveBeenCalledOnce();
        expect(contexts[0].source.connect).not.toHaveBeenCalled();
    });

    it("expires unused graphs and replenishes only after the last connection leaves", async () => {
        vi.useFakeTimers();
        const root = new MicrophoneProcessor(config);
        root.prepare();
        await vi.advanceTimersByTimeAsync(0);
        (nodes[0].port.onmessage as (event: unknown) => void)({ data: { ready: true } });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60000);
        expect(contexts[0].close).toHaveBeenCalledOnce();
        root.prepare();
        await vi.advanceTimersByTimeAsync(0);
        (nodes[1].port.onmessage as (event: unknown) => void)({ data: { ready: true } });
        await vi.advanceTimersByTimeAsync(0);
        const child = root.createProcessor();
        await init(child);
        await child.destroy();
        await vi.advanceTimersByTimeAsync(0);
        expect(contexts).toHaveLength(3);
        root.clearPrepared();
        await root.destroy();
        await vi.advanceTimersByTimeAsync(0);
        expect(contexts).toHaveLength(3);
    });
    it("rebuilds a graph that crashes while prepared instead of publishing a silent track", async () => {
        const root = new MicrophoneProcessor(config);
        root.prepare();
        await ready();
        nodes[0].onprocessorerror!();
        await init(root.createProcessor());
        expect(contexts[0].close).toHaveBeenCalledOnce();
        expect(contexts[1].source.connect).toHaveBeenCalledWith(nodes[1]);
        root.clearPrepared();
        await root.destroy();
    });

    it("times out a stalled preparation and still joins with a fresh graph", async () => {
        vi.useFakeTimers();
        const root = new MicrophoneProcessor(config);
        root.prepare();
        await vi.advanceTimersByTimeAsync(10001);
        expect(contexts[0].close).toHaveBeenCalledOnce();
        await init(root.createProcessor());
        expect(contexts[1].source.connect).toHaveBeenCalledWith(nodes[1]);
        root.clearPrepared();
        await root.destroy();
    });
});
