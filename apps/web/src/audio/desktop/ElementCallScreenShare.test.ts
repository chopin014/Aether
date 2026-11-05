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
    readonly requested: boolean;
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
    const audio = { source: "audio", stop: vi.fn(), mute: vi.fn(), unmute: vi.fn() };
    const publications = new Map<string, { track: unknown }>();
    const participant = {
        getTrackPublication: (source: string) => publications.get(source),
        createScreenTracks: vi.fn<(options: { audio: unknown }) => Promise<unknown[]>>(async (options) =>
            options.audio ? [track, audio] : [track],
        ),
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

    it.each(["NotAllowedError", "AbortError"])(
        "should treat capture %s as cancellation and allow retry",
        async (name) => {
            const { controller, participant, commit } = fixture();
            participant.createScreenTracks.mockRejectedValueOnce(new DOMException("Capture cancelled", name));

            await expect(controller.setEnabled(true)).resolves.toBeUndefined();

            expect(controller.requested).toBe(false);
            expect(participant.publishTrack).not.toHaveBeenCalled();
            expect(commit).not.toHaveBeenCalled();
            await controller.setEnabled(true, { includeSystemAudio: true });
            expect(participant.publishTrack).toHaveBeenCalledTimes(2);
            expect(controller.requested).toBe(true);
        },
    );

    it("should still report capture source failures", async () => {
        const { controller, participant, commit } = fixture();
        participant.createScreenTracks.mockRejectedValueOnce(
            new DOMException("Could not start video source", "NotReadableError"),
        );

        await expect(controller.setEnabled(true)).rejects.toThrow("Could not start video source");
        expect(controller.requested).toBe(false);
        expect(participant.publishTrack).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
    });

    it("should still report abort errors after capture succeeds", async () => {
        const { controller, participant, track } = fixture();
        participant.publishTrack.mockRejectedValueOnce(new DOMException("Publication aborted", "AbortError"));

        await expect(controller.setEnabled(true)).rejects.toThrow("Publication aborted");
        expect(track.stop).toHaveBeenCalled();
    });

    it("mutes and restores screen audio when its preference changes during sharing", async () => {
        const { controller, audio } = fixture();
        await controller.setEnabled(true, { includeSystemAudio: true });
        await controller.update({ includeSystemAudio: false });
        expect(audio.mute).toHaveBeenCalledOnce();
        await controller.update({ includeSystemAudio: true });
        expect(audio.unmute).toHaveBeenCalledOnce();
    });

    it("reopens the source picker when enabling audio after starting a video-only share", async () => {
        const { controller, participant, track, audio, commit } = fixture();
        await controller.setEnabled(true);
        const replacement = { ...track, stop: vi.fn() };
        participant.createScreenTracks.mockResolvedValueOnce([replacement, audio]);

        await controller.update({ includeSystemAudio: true });

        expect(participant.createScreenTracks).toHaveBeenCalledTimes(2);
        expect(participant.createScreenTracks).toHaveBeenLastCalledWith(
            expect.objectContaining({ audio: expect.any(Object), systemAudio: "include" }),
        );
        expect(track.stop).toHaveBeenCalledOnce();
        expect(participant.unpublishTrack).toHaveBeenCalledWith(track);
        expect(participant.getTrackPublication("screen")?.track).toBe(replacement);
        expect(participant.getTrackPublication("audio")?.track).toBe(audio);
        expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({ includeSystemAudio: true }));
    });

    it("retains confirmed preferences when the audio source picker is cancelled and permits retry", async () => {
        const { controller, participant, commit } = fixture();
        await controller.setEnabled(true);
        participant.createScreenTracks.mockRejectedValueOnce(new DOMException("Capture cancelled", "NotAllowedError"));

        await expect(controller.update({ includeSystemAudio: true })).rejects.toMatchObject({
            name: "ScreenShareCancelledError",
        });

        expect(controller.requested).toBe(false);
        expect(participant.getTrackPublication("screen")).toBeUndefined();
        expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({ includeSystemAudio: false }));
        await controller.setEnabled(true, { includeSystemAudio: true });
        expect(participant.getTrackPublication("audio")?.track).toBeDefined();
    });

    it("keeps publication aborts distinct from picker cancellation during audio reselection", async () => {
        const { controller, participant } = fixture();
        await controller.setEnabled(true);
        participant.publishTrack.mockRejectedValueOnce(new DOMException("Publication aborted", "AbortError"));

        await expect(controller.update({ includeSystemAudio: true })).rejects.toMatchObject({
            name: "AbortError",
            message: "Publication aborted",
        });
        expect(controller.requested).toBe(false);
    });

    it.each(["success", "NotAllowedError", "NotReadableError"])(
        "does not cancel a newer share when a superseded audio reselection returns %s",
        async (outcome) => {
            const { controller, participant, track, audio } = fixture();
            await controller.setEnabled(true);
            let finish!: (tracks: unknown[]) => void;
            let fail!: (error: Error) => void;
            participant.createScreenTracks.mockImplementationOnce(
                () =>
                    new Promise((resolve, reject) => {
                        finish = resolve;
                        fail = reject;
                    }),
            );
            const reselect = controller.update({ includeSystemAudio: true });
            await vi.waitFor(() => expect(participant.createScreenTracks).toHaveBeenCalledTimes(2));
            const stop = controller.setEnabled(false);
            const restart = controller.setEnabled(true, { includeSystemAudio: true });
            if (outcome === "success")
                finish([
                    { ...track, stop: vi.fn() },
                    { ...audio, stop: vi.fn() },
                ]);
            else fail(new DOMException("Capture failed", outcome));

            await expect(Promise.all([reselect, stop, restart])).resolves.toBeDefined();
            expect(participant.createScreenTracks).toHaveBeenCalledTimes(3);
            expect(controller.requested).toBe(true);
            expect(participant.getTrackPublication("audio")?.track).toBeDefined();
        },
    );

    it("does not publish audio disabled while the capture picker was pending", async () => {
        const { controller, participant, track, audio, commit } = fixture();
        let resolve!: (tracks: unknown[]) => void;
        participant.createScreenTracks.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const pending = controller.setEnabled(true, { includeSystemAudio: true });
        await vi.waitFor(() => expect(participant.createScreenTracks).toHaveBeenCalledOnce());
        const update = controller.update({ includeSystemAudio: false });
        resolve([track, audio]);
        await Promise.all([pending, update]);

        expect(participant.publishTrack).toHaveBeenCalledTimes(1);
        expect(participant.publishTrack).toHaveBeenCalledWith(track, expect.anything());
        expect(audio.stop).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({ includeSystemAudio: false }));
    });

    it("reports requested audio missing from capture instead of confirming a silent stream", async () => {
        const { controller, participant, track, commit } = fixture();
        participant.createScreenTracks.mockResolvedValueOnce([track]);

        await expect(controller.setEnabled(true, { includeSystemAudio: true })).rejects.toThrow(
            "Screen capture returned no audio track",
        );

        expect(track.stop).toHaveBeenCalled();
        expect(participant.publishTrack).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
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
            await controller.setEnabled(true, { includeSystemAudio: true });
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
        await controller.setEnabled(true, { includeSystemAudio: true });
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
