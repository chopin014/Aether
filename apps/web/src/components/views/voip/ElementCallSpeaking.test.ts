/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TestBehavior<T> {
    value: T;
    next(value: T): void;
}

interface TestMedia {
    userId: string;
    speaking$: TestBehavior<boolean>;
    audioEnabled$: TestBehavior<boolean>;
    microphoneParticipant$?: TestBehavior<TestParticipant | null>;
}

interface TestTrack {
    enabled: boolean;
    readyState: string;
    level: number;
    stop: ReturnType<typeof vi.fn>;
    clone: ReturnType<typeof vi.fn>;
}

interface TestPublication {
    isMuted: boolean;
    track?: { mediaStreamTrack: TestTrack };
}

interface TestParticipant {
    getTrackPublication: () => TestPublication;
}

const require = createRequire(import.meta.url);
const componentPath = require.resolve("@element-hq/element-call-component");
const componentRequire = createRequire(componentPath);
const rxjs = componentRequire("rxjs") as Record<string, unknown> & {
    BehaviorSubject: new <T>(value: T) => TestBehavior<T>;
    Subject: new () => { next(): void };
    takeUntil: (notifier: unknown) => unknown;
};
const source = readFileSync(componentPath, "utf8");
const start = source.indexOf("// Forward real, unmuted speech activity to component hosts");
const end = source.indexOf("\n\t// Let component hosts such as Aether's sidebar offer screen sharing", start);
const helperStart = source.indexOf("let aetherSpeakingContext;");
const helperEnd = source.indexOf("function v3(", helperStart);

function createPublisher(initialMedia: TestMedia[]) {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const media$ = new rxjs.BehaviorSubject(initialMedia);
    const disposed$ = new rxjs.Subject();
    const onEnd: (() => void)[] = [];
    const notifySpeakingUsers = vi.fn<(userIds: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const warn = vi.fn();

    // Execute the installed patch with real RxJS operators so compiled alias and selector mistakes are exercised.
    const runPublisher = new Function(
        "ue",
        "p",
        "e",
        "l",
        "wA",
        "Ck",
        "Lk",
        "F",
        "$e",
        "C",
        "Z",
        source.slice(helperStart, helperEnd) + source.slice(start, end),
    );
    runPublisher(
        media$,
        { notifySpeakingUsers },
        { bind: () => rxjs.takeUntil(disposed$), onEnd: (callback: () => void) => onEnd.push(callback) },
        { warn },
        rxjs.switchMap,
        rxjs.of,
        rxjs.combineLatest,
        rxjs.map,
        rxjs.distinctUntilChanged,
        rxjs.Observable,
        { Source: { Microphone: "microphone" } },
    );

    return {
        media$,
        notifySpeakingUsers,
        warn,
        dispose: () => {
            disposed$.next();
            onEnd.forEach((callback) => callback());
        },
    };
}

function createMedia(userId: string, speaking = false, enabled = true): TestMedia {
    return {
        userId,
        speaking$: new rxjs.BehaviorSubject(speaking),
        audioEnabled$: new rxjs.BehaviorSubject(enabled),
    };
}

describe("embedded Element Call speaking publisher", () => {
    it("reports real local and remote speech, excluding muted microphones", () => {
        const local = createMedia("@local:example.org");
        const remote = createMedia("@remote:example.org");
        const publisher = createPublisher([local, remote]);

        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        local.speaking$.next(true);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.userId]);
        remote.speaking$.next(true);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.userId, remote.userId]);
        local.audioEnabled$.next(false);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([remote.userId]);
        remote.speaking$.next(false);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        publisher.dispose();
    });

    it("deduplicates devices and unsubscribes from media that leave the call", () => {
        const first = createMedia("@local:example.org", true);
        const second = createMedia(first.userId, true);
        const remote = createMedia("@remote:example.org", true);
        const publisher = createPublisher([remote, first, second]);

        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([first.userId, remote.userId]);
        const count = publisher.notifySpeakingUsers.mock.calls.length;
        first.speaking$.next(false);
        expect(publisher.notifySpeakingUsers).toHaveBeenCalledTimes(count);
        publisher.media$.next([remote]);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([remote.userId]);
        second.speaking$.next(false);
        expect(publisher.notifySpeakingUsers).toHaveBeenCalledTimes(count + 1);
        publisher.media$.next([]);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        publisher.dispose();
    });

    it("observes newly joined media and clears speech when its scope ends", () => {
        const publisher = createPublisher([]);
        const local = createMedia("@local:example.org", true);

        publisher.media$.next([local]);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.userId]);
        publisher.dispose();
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        const count = publisher.notifySpeakingUsers.mock.calls.length;
        local.speaking$.next(false);
        local.speaking$.next(true);
        publisher.media$.next([createMedia("@remote:example.org", true)]);
        expect(publisher.notifySpeakingUsers).toHaveBeenCalledTimes(count);
    });

    it("handles a rejected host notification without losing subsequent activity", async () => {
        const local = createMedia("@local:example.org");
        const publisher = createPublisher([local]);
        const error = new Error("Host unavailable");
        publisher.notifySpeakingUsers.mockRejectedValueOnce(error);

        local.speaking$.next(true);
        await Promise.resolve();
        expect(publisher.warn).toHaveBeenCalledWith("Could not send speaking users to the host", error);
        local.speaking$.next(false);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        publisher.dispose();
    });
});

class TestMediaStream {
    public constructor(public readonly tracks: TestTrack[]) {}
}

class TestAnalyser {
    public fftSize = 1024;
    public track?: TestTrack;
    public disconnect = vi.fn();
    public getFloatTimeDomainData = (samples: Float32Array): void => {
        samples.fill(this.track?.level ?? 0);
    };
}

class TestAudioContext {
    public static instances: TestAudioContext[] = [];
    public static initialState = "running";
    public state = TestAudioContext.initialState;
    public readonly sources: {
        stream: TestMediaStream;
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
    }[] = [];
    public readonly analysers: TestAnalyser[] = [];
    public resume = vi.fn(async () => {});
    public close = vi.fn(async () => {
        this.state = "closed";
    });

    public constructor() {
        TestAudioContext.instances.push(this);
    }

    public createAnalyser = (): TestAnalyser => {
        const analyser = new TestAnalyser();
        this.analysers.push(analyser);
        return analyser;
    };

    public createMediaStreamSource = (stream: TestMediaStream) => {
        const source = {
            stream,
            connect: vi.fn((analyser: TestAnalyser) => {
                analyser.track = stream.tracks[0];
            }),
            disconnect: vi.fn(),
        };
        this.sources.push(source);
        return source;
    };
}

function createMicrophone(userId: string) {
    const track: TestTrack = { enabled: true, readyState: "live", level: 0, stop: vi.fn(), clone: vi.fn() };
    const publication: TestPublication = { isMuted: false, track: { mediaStreamTrack: track } };
    const participant: TestParticipant = { getTrackPublication: () => publication };
    const media: TestMedia = {
        ...createMedia(userId),
        microphoneParticipant$: new rxjs.BehaviorSubject<TestParticipant | null>(participant),
    };
    return { media, publication, track };
}

describe("immediate microphone activity for the sidebar", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
        TestAudioContext.instances = [];
        TestAudioContext.initialState = "running";
        vi.stubGlobal("AudioContext", TestAudioContext);
        vi.stubGlobal("webkitAudioContext", undefined);
        vi.stubGlobal("MediaStream", TestMediaStream);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("detects local and remote speech within 40ms and bridges pauses and releases within 400ms", () => {
        const local = createMicrophone("@local:example.org");
        const remote = createMicrophone("@remote:example.org");
        const publisher = createPublisher([local.media, remote.media]);

        local.track.level = 0.03;
        remote.track.level = 0.02;
        vi.advanceTimersByTime(39);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        vi.advanceTimersByTime(1);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId, remote.media.userId]);
        local.track.level = remote.track.level = 0;
        vi.advanceTimersByTime(399);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId, remote.media.userId]);
        vi.advanceTimersByTime(1);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        expect(local.media.speaking$.value).toBe(false);
        expect(remote.media.speaking$.value).toBe(false);
        publisher.dispose();
    });

    it("keeps the ring steady across syllables and restarts the silence window on speech", () => {
        const local = createMicrophone("@local:example.org");
        local.track.level = 0.03;
        const publisher = createPublisher([local.media]);
        const count = publisher.notifySpeakingUsers.mock.calls.length;
        local.track.level = 0;
        vi.advanceTimersByTime(320);
        local.track.level = 0.03;
        vi.advanceTimersByTime(40);
        local.track.level = 0;
        vi.advanceTimersByTime(399);
        expect(publisher.notifySpeakingUsers).toHaveBeenCalledTimes(count);
        vi.advanceTimersByTime(1);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        publisher.dispose();
    });

    it("clears muted, disabled, ended and departed microphones", () => {
        const local = createMicrophone("@local:example.org");
        local.track.level = 0.04;
        const publisher = createPublisher([local.media]);

        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId]);
        local.publication.isMuted = true;
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        local.publication.isMuted = false;
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId]);
        local.track.enabled = false;
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        local.track.enabled = true;
        vi.advanceTimersByTime(40);
        local.track.readyState = "ended";
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        local.track.readyState = "live";
        vi.advanceTimersByTime(40);
        publisher.media$.next([]);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        expect(vi.getTimerCount()).toBe(0);
        publisher.dispose();
    });

    it("follows restarted or processed tracks without stopping or cloning either track", () => {
        const local = createMicrophone("@local:example.org");
        local.track.level = 0.04;
        const publisher = createPublisher([local.media]);
        const context = TestAudioContext.instances[0];
        const replacement = { ...local.track, level: 0, stop: vi.fn(), clone: vi.fn() };

        local.publication.track = { mediaStreamTrack: replacement };
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
        expect(context.sources[1].stream.tracks).toEqual([replacement]);
        replacement.level = 0.04;
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId]);
        publisher.dispose();
        expect(local.track.stop).not.toHaveBeenCalled();
        expect(local.track.clone).not.toHaveBeenCalled();
        expect(replacement.stop).not.toHaveBeenCalled();
        expect(replacement.clone).not.toHaveBeenCalled();
    });

    it("shares its audio context and releases all analysers, sources and timers on disposal", () => {
        const local = createMicrophone("@local:example.org");
        const remote = createMicrophone("@remote:example.org");
        const publisher = createPublisher([local.media, remote.media]);
        const context = TestAudioContext.instances[0];

        expect(TestAudioContext.instances).toHaveLength(1);
        expect(context.sources).toHaveLength(2);
        for (const source of context.sources) expect(source.connect).toHaveBeenCalledWith(expect.any(TestAnalyser));
        publisher.dispose();
        for (const source of context.sources) expect(source.disconnect).toHaveBeenCalledOnce();
        for (const analyser of context.analysers) expect(analyser.disconnect).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("falls back to SFU speaking activity when WebAudio is unavailable", () => {
        vi.stubGlobal("AudioContext", undefined);
        const local = createMicrophone("@local:example.org");
        const publisher = createPublisher([local.media]);

        local.media.speaking$.next(true);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId]);
        local.media.speaking$.next(false);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        expect(TestAudioContext.instances).toHaveLength(0);
        publisher.dispose();
    });

    it("uses SFU activity while suspended and prefers samples once its context runs", () => {
        TestAudioContext.initialState = "suspended";
        const local = createMicrophone("@local:example.org");
        local.media.speaking$.next(true);
        const publisher = createPublisher([local.media]);
        const context = TestAudioContext.instances[0];

        expect(context.resume).toHaveBeenCalledOnce();
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId]);
        context.state = "running";
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        local.track.level = 0.04;
        vi.advanceTimersByTime(40);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId]);
        publisher.dispose();
    });
});
