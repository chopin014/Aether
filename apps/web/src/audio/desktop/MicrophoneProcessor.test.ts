/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicrophoneProcessor } from "./MicrophoneProcessor";

interface FakeScriptProcessor {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onaudioprocess: ((event: unknown) => void) | null;
}

function fakeContext(): {
    context: AudioContext;
    source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    script: FakeScriptProcessor;
    outputTrack: { stop: ReturnType<typeof vi.fn> };
} {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const script: FakeScriptProcessor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
    const outputTrack = { stop: vi.fn() };
    const context = {
        sampleRate: 48000,
        createMediaStreamSource: vi.fn().mockReturnValue(source),
        createScriptProcessor: vi.fn().mockReturnValue(script),
        createMediaStreamDestination: vi.fn().mockReturnValue({ stream: { getAudioTracks: () => [outputTrack] } }),
    } as unknown as AudioContext;
    return { context, source, script, outputTrack };
}

/** Delivers `blocks` blocks of constant level to the processor and returns the last output block. */
function feed(script: FakeScriptProcessor, level: number, blocks = 50): Float32Array {
    const input = new Float32Array(512).fill(level);
    let output = new Float32Array(512);
    for (let i = 0; i < blocks; i++) {
        output = new Float32Array(512);
        script.onaudioprocess!({
            inputBuffer: { getChannelData: () => input },
            outputBuffer: { getChannelData: () => output },
        });
    }
    return output;
}

describe("MicrophoneProcessor", () => {
    const track = { id: "mic" } as unknown as MediaStreamTrack;

    beforeEach(() => {
        vi.stubGlobal(
            "MediaStream",
            class {
                public constructor(public readonly tracks: MediaStreamTrack[]) {}
            },
        );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("sends the microphone through the audio graph and exposes the processed track", async () => {
        const { context, source, script, outputTrack } = fakeContext();
        const processor = new MicrophoneProcessor({ volume: 1, threshold: null, pushToTalk: false });
        await processor.init({ kind: "audio", track, audioContext: context });
        expect(source.connect).toHaveBeenCalledWith(script);
        expect(script.connect).toHaveBeenCalled();
        expect(processor.processedTrack).toBe(outputTrack);
    });

    it("applies the volume to the samples", async () => {
        const { context, script } = fakeContext();
        const processor = new MicrophoneProcessor({ volume: 0.5, threshold: null, pushToTalk: false });
        await processor.init({ kind: "audio", track, audioContext: context });
        expect(feed(script, 0.2)[511]).toBeCloseTo(0.1, 4);
        processor.setConfig({ volume: 0, threshold: null, pushToTalk: false });
        expect(feed(script, 0.2)[511]).toBe(0);
    });

    it("reports the level and whether the gate is open", async () => {
        const { context, script } = fakeContext();
        const processor = new MicrophoneProcessor({ volume: 1, threshold: -30, pushToTalk: false });
        const onLevel = vi.fn();
        processor.onLevel = onLevel;
        await processor.init({ kind: "audio", track, audioContext: context });
        feed(script, 0.001, 1);
        expect(onLevel).toHaveBeenLastCalledWith(expect.closeTo(-60, 0), false);
        feed(script, 0.3, 1);
        expect(onLevel).toHaveBeenLastCalledWith(expect.closeTo(-10.5, 0), true);
    });

    it("follows push to talk, including a key held before the track was captured", async () => {
        const { context, script } = fakeContext();
        const processor = new MicrophoneProcessor({ volume: 1, threshold: null, pushToTalk: true });
        processor.setPushToTalkActive(true);
        await processor.init({ kind: "audio", track, audioContext: context });
        expect(feed(script, 0.2)[511]).toBeCloseTo(0.2, 4);
        processor.setPushToTalkActive(false);
        expect(feed(script, 0.2)[511]).toBe(0);
    });

    it("rebuilds the graph when the track restarts, and tears down the old one", async () => {
        const first = fakeContext();
        const processor = new MicrophoneProcessor({ volume: 1, threshold: null, pushToTalk: false });
        await processor.init({ kind: "audio", track, audioContext: first.context });
        const second = fakeContext();
        await processor.restart({ kind: "audio", track, audioContext: second.context });
        expect(first.source.disconnect).toHaveBeenCalled();
        expect(first.script.onaudioprocess).toBeNull();
        expect(first.outputTrack.stop).toHaveBeenCalled();
        expect(processor.processedTrack).toBe(second.outputTrack);
    });

    it("stops everything on destroy", async () => {
        const { context, source, script, outputTrack } = fakeContext();
        const processor = new MicrophoneProcessor({ volume: 1, threshold: null, pushToTalk: false });
        await processor.init({ kind: "audio", track, audioContext: context });
        await processor.destroy();
        expect(source.disconnect).toHaveBeenCalled();
        expect(script.disconnect).toHaveBeenCalled();
        expect(outputTrack.stop).toHaveBeenCalled();
        expect(processor.processedTrack).toBeUndefined();
        // A second destroy, as LiveKit may do on stopping, is harmless.
        await expect(processor.destroy()).resolves.toBeUndefined();
    });
});
