/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicrophoneProcessor } from "./MicrophoneProcessor";
import { loadMicrophoneGateWorklet } from "./microphoneGateWorkletFactory";

vi.mock("./microphoneGateWorkletFactory", () => ({ loadMicrophoneGateWorklet: vi.fn().mockResolvedValue(undefined) }));

function fakeContext(): {
    context: AudioContext;
    source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    outputTrack: { stop: ReturnType<typeof vi.fn>; enabled: boolean };
} {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const outputTrack = { stop: vi.fn(), enabled: true };
    return {
        source,
        outputTrack,
        context: {
            sampleRate: 48000,
            createMediaStreamSource: vi.fn().mockReturnValue(source),
            createMediaStreamDestination: vi.fn().mockReturnValue({ stream: { getAudioTracks: () => [outputTrack] } }),
        } as unknown as AudioContext,
    };
}

describe("MicrophoneProcessor", () => {
    let nodes: Array<{
        port: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onmessage: unknown };
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        onprocessorerror?: () => void;
        options: AudioWorkletNodeOptions;
    }>;
    const config = { volume: 1, threshold: null, pushToTalk: false } as const;
    const track = (): MediaStreamTrack => ({ id: "mic", enabled: true }) as MediaStreamTrack;

    beforeEach(() => {
        vi.mocked(loadMicrophoneGateWorklet).mockReset().mockResolvedValue(undefined);
        nodes = [];
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
    afterEach(() => vi.unstubAllGlobals());

    it("loads the audio-thread module before connecting capture, with the current hold state", async () => {
        const { context, source, outputTrack } = fakeContext();
        const processor = new MicrophoneProcessor({ ...config, pushToTalk: true });
        processor.setPushToTalkActive(true);
        processor.setShortcutMuted(true);
        await processor.init({ kind: "audio", track: track(), audioContext: context });
        expect(loadMicrophoneGateWorklet).toHaveBeenCalledWith(context);
        expect(nodes[0].options.processorOptions).toEqual({
            config: { ...config, pushToTalk: true },
            pushToTalkActive: true,
            shortcutMuted: true,
        });
        expect(source.connect).toHaveBeenCalledWith(nodes[0]);
        expect(processor.processedTrack).toBe(outputTrack);
    });

    it("sends complete state updates to every independent connection", async () => {
        const root = new MicrophoneProcessor(config);
        const a = root.createProcessor();
        const b = root.createProcessor();
        await a.init({ kind: "audio", track: track(), audioContext: fakeContext().context });
        await b.init({ kind: "audio", track: track(), audioContext: fakeContext().context });
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
        await processor.init({ kind: "audio", track: track(), audioContext: fakeContext().context });
        (nodes[0].port.onmessage as (event: unknown) => void)({ data: { level: -35, open: true } });
        expect(processor.onLevel).toHaveBeenCalledWith(-35, true);
    });

    it("fails initialization instead of returning an unprocessed microphone", async () => {
        vi.mocked(loadMicrophoneGateWorklet).mockRejectedValue(new Error("module blocked"));
        const processor = new MicrophoneProcessor(config);
        const original = track();
        await expect(
            processor.init({ kind: "audio", track: original, audioContext: fakeContext().context }),
        ).rejects.toThrow("module blocked");
        expect(processor.processedTrack).toBeUndefined();
        expect(nodes).toHaveLength(0);
    });

    it("cannot finish initialization after disposal", async () => {
        let resolve!: () => void;
        vi.mocked(loadMicrophoneGateWorklet).mockReturnValue(
            new Promise<void>((r) => {
                resolve = r;
            }),
        );
        const processor = new MicrophoneProcessor(config);
        const pending = processor.init({ kind: "audio", track: track(), audioContext: fakeContext().context });
        await processor.destroy();
        resolve();
        await expect(pending).rejects.toThrow("cancelled");
        expect(processor.processedTrack).toBeUndefined();
    });

    it("silences both the processed output and source on a worklet crash", async () => {
        const { context, outputTrack } = fakeContext();
        const input = track();
        const processor = new MicrophoneProcessor(config);
        await processor.init({ kind: "audio", track: input, audioContext: context });
        nodes[0].onprocessorerror!();
        expect(outputTrack.enabled).toBe(false);
        expect(input.enabled).toBe(false);
    });

    it("restarts one graph without stopping another connection, then disposes all children", async () => {
        const root = new MicrophoneProcessor(config);
        const a = root.createProcessor();
        const b = root.createProcessor();
        const first = fakeContext();
        const second = fakeContext();
        await a.init({ kind: "audio", track: track(), audioContext: first.context });
        await b.init({ kind: "audio", track: track(), audioContext: second.context });
        await a.restart({ kind: "audio", track: track(), audioContext: fakeContext().context });
        expect(first.outputTrack.stop).toHaveBeenCalledOnce();
        expect(second.outputTrack.stop).not.toHaveBeenCalled();
        await root.destroy();
        expect(second.outputTrack.stop).toHaveBeenCalledOnce();
        expect(nodes[0].port.onmessage).toBeNull();
        expect(nodes[0].port.close).toHaveBeenCalled();
        await expect(root.destroy()).resolves.toBeUndefined();
    });
});
