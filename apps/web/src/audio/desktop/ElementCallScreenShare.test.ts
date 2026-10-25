/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const source = readFileSync(
    path.join(path.dirname(require.resolve("@element-hq/element-call-component")), "aether-screen-share.js"),
    "utf8",
);
type Quality = { resolutionHeight: number; frameRate: number; maxBitrate: number; includeSystemAudio: boolean };
type Controller = {
    setEnabled(enabled: boolean, quality?: Partial<Quality>): Promise<void>;
    update(quality: Partial<Quality>): Promise<void>;
    dispose(): Promise<void>;
};
const helpers = runInNewContext(
    `${source.replaceAll("export ", "")}; ({ aetherResolveScreenShareQuality, aetherCreateScreenShareController, aetherConstrainScreenSenders, aetherHasLiveScreenShareAudio })`,
) as {
    aetherHasLiveScreenShareAudio(reference: unknown): boolean;
    aetherResolveScreenShareQuality(policy: unknown, raw: unknown): Quality;
    aetherCreateScreenShareController(options: unknown): Controller;
    aetherConstrainScreenSenders(track: unknown, quality: Quality): Promise<void>;
};

function fixture() {
    const mediaStreamTrack = { applyConstraints: vi.fn().mockResolvedValue(undefined), addEventListener: vi.fn() };
    const sender = {
        getParameters: vi.fn(() => ({ encodings: [{ maxBitrate: 9_000_000 }, { maxBitrate: 200_000 }] })),
        setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const track = { source: "screen", mediaStreamTrack, sender, stop: vi.fn() };
    const audio = { source: "audio", stop: vi.fn() };
    const publications = new Map<string, { track: unknown }>();
    const participant = {
        getTrackPublication: (source: string) => publications.get(source),
        createScreenTracks: vi.fn().mockResolvedValue([track, audio]),
        publishTrack: vi.fn(async (item: typeof track, _options?: unknown) =>
            publications.set(item.source, { track: item }),
        ),
        unpublishTrack: vi.fn(async (item: typeof track) => publications.delete(item.source)),
    };
    const commit = vi.fn();
    const controller = helpers.aetherCreateScreenShareController({
        participant,
        policy: { max_resolution: 900, max_framerate: 24, max_bitrate: 2_000_000 },
        quality: { resolutionHeight: 1080, frameRate: 30, maxBitrate: null, includeSystemAudio: false },
        sources: { video: "screen", audio: "audio" },
        commit,
    });
    return { controller, participant, commit, track, audio, mediaStreamTrack, sender };
}

describe("Element Call screen capture publication boundary", () => {
    it("caps capture before publication and every sender layer to deployment policy", async () => {
        const { controller, participant, mediaStreamTrack, sender, commit } = fixture();
        await controller.setEnabled(true, { resolutionHeight: 1440, frameRate: 60, maxBitrate: 6_000_000 });
        expect(mediaStreamTrack.applyConstraints).toHaveBeenCalledWith({
            width: { ideal: 1600, max: 1600 },
            height: { ideal: 900, max: 900 },
            frameRate: { ideal: 24, max: 24 },
        });
        expect(mediaStreamTrack.applyConstraints.mock.invocationCallOrder[0]).toBeLessThan(
            participant.publishTrack.mock.invocationCallOrder[0],
        );
        expect(sender.setParameters).toHaveBeenCalledWith({
            encodings: [
                { maxBitrate: 2_000_000, maxFramerate: 24 },
                { maxBitrate: 200_000, maxFramerate: 24 },
            ],
        });
        expect(participant.publishTrack.mock.calls[0][1]).toMatchObject({ simulcast: false, backupCodec: false });
        expect(commit).toHaveBeenCalledWith({
            resolutionHeight: 900,
            frameRate: 24,
            maxBitrate: 2_000_000,
            includeSystemAudio: false,
        });
    });

    it("bounds all encodings of a backup codec too", async () => {
        const { track, sender } = fixture();
        const backup = { ...sender, setParameters: vi.fn() };
        await helpers.aetherConstrainScreenSenders(
            { ...track, simulcastCodecs: new Map([["h264", { sender: backup }]]) },
            { resolutionHeight: 720, frameRate: 15, maxBitrate: 1_500_000, includeSystemAudio: false },
        );
        expect(backup.setParameters).toHaveBeenCalledWith({
            encodings: [
                { maxBitrate: 1_500_000, maxFramerate: 15 },
                { maxBitrate: 200_000, maxFramerate: 15 },
            ],
        });
    });

    it.each(["capture", "sender"])(
        "reports %s failures, stops tracks, and retains the last applied preference",
        async (failure) => {
            const { controller, participant, mediaStreamTrack, sender, commit, track, audio } = fixture();
            await controller.setEnabled(true);
            commit.mockClear();
            if (failure === "capture") mediaStreamTrack.applyConstraints.mockRejectedValue(new Error("capture failed"));
            else sender.setParameters.mockRejectedValue(new Error("sender failed"));
            await expect(controller.update({ frameRate: 15 })).rejects.toThrow(`${failure} failed`);
            expect(track.stop).toHaveBeenCalled();
            expect(audio.stop).toHaveBeenCalled();
            expect(participant.unpublishTrack).toHaveBeenCalledTimes(2);
            expect(commit).not.toHaveBeenCalled();
        },
    );

    it("never publishes a late permission result after cancellation or disposal", async () => {
        for (const dispose of [false, true]) {
            const { controller, participant, track, audio, commit } = fixture();
            let resolve!: (tracks: unknown[]) => void;
            participant.createScreenTracks.mockImplementation(
                () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            );
            const pending = controller.setEnabled(true);
            await vi.waitFor(() => expect(participant.createScreenTracks).toHaveBeenCalledOnce());
            const stop = dispose ? controller.dispose() : controller.setEnabled(false);
            resolve([track, audio]);
            await Promise.all([pending, stop]);
            expect(participant.publishTrack).not.toHaveBeenCalled();
            expect(track.stop).toHaveBeenCalled();
            expect(audio.stop).toHaveBeenCalled();
            expect(commit).not.toHaveBeenCalled();
        }
    });

    it("merges queued partial changes from the last successful complete preference", async () => {
        const { controller, commit } = fixture();
        await Promise.all([controller.update({ frameRate: 15 }), controller.update({ resolutionHeight: 720 })]);
        expect(commit).toHaveBeenLastCalledWith({
            resolutionHeight: 720,
            frameRate: 15,
            maxBitrate: 2_000_000,
            includeSystemAudio: false,
        });
    });

    it("validates non-finite values and does not request system audio by default", () => {
        expect(
            helpers.aetherResolveScreenShareQuality(
                { max_resolution: Infinity, max_bitrate: NaN },
                {
                    frameRate: Infinity,
                    maxBitrate: NaN,
                    resolutionHeight: -10,
                },
            ),
        ).toEqual({ resolutionHeight: 1080, frameRate: 30, maxBitrate: 5_000_000, includeSystemAudio: false });
    });
    it("allows the primary sender bitrate to rise after a reduction while preserving lower layer limits", async () => {
        const { controller, sender } = fixture();
        let parameters = { encodings: [{ maxBitrate: 9_000_000 }, { maxBitrate: 200_000 }] };
        sender.getParameters.mockImplementation(() => structuredClone(parameters));
        sender.setParameters.mockImplementation(async (next) => {
            parameters = next;
        });
        await controller.setEnabled(true);
        await controller.update({ maxBitrate: 1_500_000 });
        expect(parameters.encodings[0].maxBitrate).toBe(1_500_000);
        await controller.update({ maxBitrate: 2_000_000 });
        expect(parameters.encodings.map((encoding) => encoding.maxBitrate)).toEqual([2_000_000, 200_000]);
    });

    it("uses the native picker's latest quality before the first publication when capture resolves late", async () => {
        const { controller, participant, mediaStreamTrack, track, audio } = fixture();
        let resolve!: (tracks: unknown[]) => void;
        participant.createScreenTracks.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const pending = controller.setEnabled(true);
        await vi.waitFor(() => expect(participant.createScreenTracks).toHaveBeenCalledOnce());
        const update = controller.update({ resolutionHeight: 720, frameRate: 15, maxBitrate: 1_500_000 });
        resolve([track, audio]);
        await Promise.all([pending, update]);
        expect(mediaStreamTrack.applyConstraints.mock.calls[0][0]).toMatchObject({
            height: { max: 720 },
            frameRate: { max: 15 },
        });
        expect(participant.publishTrack.mock.calls[0][1]).toMatchObject({
            screenShareEncoding: { maxBitrate: 1_500_000, maxFramerate: 15 },
        });
    });

    it("releases screen audio as well as video when the OS ends capture", async () => {
        const { controller, participant, track, audio, mediaStreamTrack } = fixture();
        await controller.setEnabled(true);
        const ended = mediaStreamTrack.addEventListener.mock.calls.find(([event]) => event === "ended")![1];
        ended();
        await vi.waitFor(() => expect(participant.unpublishTrack).toHaveBeenCalledTimes(2));
        expect(track.stop).toHaveBeenCalled();
        expect(audio.stop).toHaveBeenCalled();
    });

    it("does not remove another controller's publication when a previous capture scope is disposed", async () => {
        const { controller, participant } = fixture();
        const foreignTrack = { source: "screen" } as ReturnType<typeof fixture>["track"];
        await participant.publishTrack(foreignTrack);
        await controller.dispose();
        expect(participant.unpublishTrack).not.toHaveBeenCalled();
        expect(participant.getTrackPublication("screen")?.track).toBe(foreignTrack);
    });

    it("uses actual live stream audio publication rather than a requested preference", () => {
        expect(helpers.aetherHasLiveScreenShareAudio(null)).toBe(false);
        expect(helpers.aetherHasLiveScreenShareAudio({ includeSystemAudio: true })).toBe(false);
        expect(
            helpers.aetherHasLiveScreenShareAudio({
                publication: { track: { mediaStreamTrack: { readyState: "live" } }, isMuted: false },
            }),
        ).toBe(true);
        expect(
            helpers.aetherHasLiveScreenShareAudio({
                publication: { track: { mediaStreamTrack: { readyState: "ended" } }, isMuted: false },
            }),
        ).toBe(false);
        expect(
            helpers.aetherHasLiveScreenShareAudio({
                publication: { track: { mediaStreamTrack: { readyState: "live" } }, isMuted: true },
            }),
        ).toBe(false);
    });

    it("preserves upstream system audio capture and developer codec settings for hosts outside Aether", async () => {
        const bundle = readFileSync(
            path.join(path.dirname(require.resolve("@element-hq/element-call-component")), "element-call.js"),
            "utf8",
        );
        const start = bundle.indexOf("pe = (qualityOverride) => {") + "pe = ".length;
        const end = bundle.indexOf("\n\t}), {", start) + 3;
        const publish = vi.fn().mockResolvedValue(undefined);
        const toggle = runInNewContext(`(${bundle.slice(start, end)})`, {
            p: {},
            aetherAudio: { screenShareConfigured: false },
            O: { getValue: () => true },
            kt: () => ({ width: 1920, height: 1080 }),
            _t: { getValue: () => "1080p" },
            Be: { getValue: () => 25 },
            Ct: { getValue: () => 4_000_000 },
            it: { getValue: () => "vp9" },
            de: { value: false },
            ue: { value: { setScreenShareEnabled: publish } },
            _: { info: vi.fn() },
            T4: (promise: Promise<unknown>) => promise,
        }) as () => void;
        toggle();
        expect(publish).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
                audio: { autoGainControl: false, noiseSuppression: false, voiceIsolation: false },
                systemAudio: "include",
            }),
            { screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 25 }, videoCodec: "vp9" },
        );
    });
});
