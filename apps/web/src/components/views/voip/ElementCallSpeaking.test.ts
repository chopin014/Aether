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
    instantSpeaking$?: TestBehavior<boolean>;
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
const end = source.indexOf("\n\treturn {\n\t\tautoLeave$:", start);
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
        source.slice(helperStart, helperEnd) + source.slice(start, end) + "\nreturn aetherSpeakingActivity;",
    );
    const activityFor = runPublisher(
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
    ) as (media: TestMedia) => TestBehavior<boolean>;

    return {
        media$,
        notifySpeakingUsers,
        warn,
        activityFor,
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

    it("detects local and remote speech within 40ms and releases within 120ms", () => {
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
        vi.advanceTimersByTime(119);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.media.userId, remote.media.userId]);
        vi.advanceTimersByTime(1);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([]);
        expect(local.media.speaking$.value).toBe(false);
        expect(remote.media.speaking$.value).toBe(false);
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

function renderCallAvatar(
    view: "grid" | "spotlight",
    vm: TestMedia,
    activityFor: (media: TestMedia) => TestBehavior<boolean>,
) {
    const startMarker = view === "grid" ? "D2 = (e) => {" : "C8 = (e) => {";
    const endMarker = view === "grid" ? "}, O2 = " : "};\nC8.displayName";
    const viewStart = source.indexOf(startMarker);
    const viewEnd = source.indexOf(endMarker, viewStart);
    expect(viewStart).toBeGreaterThan(-1);
    expect(viewEnd).toBeGreaterThan(viewStart);
    const aliases: Record<string, unknown> = {
        I: () => [],
        P: (behavior: TestBehavior<unknown>) => behavior.value,
        B: () => [false, vi.fn()],
        rZ: () => ({ toggleRaisedHand: vi.fn() }),
        Je: () => ({ t: (key: string) => key }),
        H: (component: unknown, props: Record<string, unknown>) => ({ component, props }),
        aetherSpeakingActivity: activityFor,
        JT: { default: (...args: unknown[]) => JSON.stringify(args) },
        lQ: { tile: "tile", speaking: "speaking", handRaised: "handRaised", muteIcon: "muteIcon" },
        Br: "muted",
        xr: "microphone",
        yr: "microphoneOff",
        Cr: "options",
        En: "menu",
        C2: "MediaView",
        x8: "local",
        S8: "remote",
    };
    // Exercise the installed view's props with React hooks reduced to their current observable values.
    const createView = new Function(...Object.keys(aliases), `return ${source.slice(viewStart + 5, viewEnd + 1)};`);
    const render = createView(...Object.values(aliases)) as (props: Record<string, unknown>) => {
        props: Record<string, unknown>;
    };
    const behavior = <T>(value: T): TestBehavior<T> => new rxjs.BehaviorSubject(value);
    return render({
        vm: {
            ...vm,
            local: true,
            video$: behavior(undefined),
            videoEnabled$: behavior(false),
            unencryptedWarning$: behavior(false),
            audioStreamStats$: behavior(undefined),
            videoStreamStats$: behavior(undefined),
            handRaised$: behavior(null),
            reaction$: behavior(null),
        },
        showSpeakingIndicators: false,
        displayName: "Alice",
        focusable: true,
        targetWidth: 640,
        targetHeight: 480,
        background: "solid",
    }).props;
}

describe("main call avatars", () => {
    it.each(["grid", "spotlight"] as const)("uses the same fast signal as the sidebar in %s", (view) => {
        const local = createMedia("@local:example.org", false);
        local.instantSpeaking$ = new rxjs.BehaviorSubject(false);
        const publisher = createPublisher([local]);

        expect(publisher.activityFor(local)).toBe(local.instantSpeaking$);
        expect(renderCallAvatar(view, local, publisher.activityFor).soundWaves).toBe(false);
        local.instantSpeaking$.next(true);
        expect(publisher.notifySpeakingUsers).toHaveBeenLastCalledWith([local.userId]);
        expect(renderCallAvatar(view, local, publisher.activityFor).soundWaves).toBe(true);
        expect(renderCallAvatar(view, local, publisher.activityFor)["data-speaking"]).toBe(true);
        local.audioEnabled$.next(false);
        expect(renderCallAvatar(view, local, publisher.activityFor).soundWaves).toBe(false);
        publisher.dispose();
    });
});

function microphoneTrackFactory(warn: ReturnType<typeof vi.fn>) {
    const helperStart = source.indexOf("async function aetherCreateMicrophoneTracks(");
    const helperEnd = source.indexOf("var U4 = class", helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    return new Function("Z", "V", `${source.slice(helperStart, helperEnd)}\nreturn aetherCreateMicrophoneTracks;`)(
        { Kind: { Audio: "audio" } },
        { warn },
    ) as (
        room: { audioContext?: object; acquireAudioContext: () => Promise<void> },
        capture: (options: object) => Promise<object[]>,
        options: object,
        bridge: { createMicrophoneProcessor: () => object },
    ) => Promise<object[]>;
}

describe("microphone processor startup", () => {
    it("initializes SDK audio before capture and installs the processor before returning tracks to publish", async () => {
        const events: string[] = [];
        const room = {
            audioContext: undefined as object | undefined,
            acquireAudioContext: async () => {
                events.push("context");
                room.audioContext = {};
            },
        };
        const processor = { destroy: vi.fn() };
        const microphone = {
            kind: "audio",
            setProcessor: vi.fn(async () => {
                expect(room.audioContext).toBeDefined();
                events.push("processor");
            }),
        };
        const camera = { kind: "video", setProcessor: vi.fn() };
        const capture = vi.fn(async () => {
            events.push("capture");
            return [microphone, camera];
        });
        const options = { audio: true };
        const tracks = await microphoneTrackFactory(vi.fn())(room, capture, options, {
            createMicrophoneProcessor: () => processor,
        });
        expect(events).toEqual(["context", "capture", "processor"]);
        expect(capture).toHaveBeenCalledWith(options);
        expect(tracks).toEqual([microphone, camera]);
        expect(microphone.setProcessor).toHaveBeenCalledWith(processor);
        expect(camera.setProcessor).not.toHaveBeenCalled();
    });

    it("keeps microphone capture working when an audio context is unavailable", async () => {
        const error = new Error("Audio context unavailable");
        const room = { acquireAudioContext: vi.fn().mockRejectedValue(error) };
        const microphone = { kind: "audio", setProcessor: vi.fn() };
        const warn = vi.fn();
        const createMicrophoneProcessor = vi.fn();
        const tracks = await microphoneTrackFactory(warn)(
            room,
            async () => [microphone],
            {},
            {
                createMicrophoneProcessor,
            },
        );
        expect(tracks).toEqual([microphone]);
        expect(createMicrophoneProcessor).not.toHaveBeenCalled();
        expect(microphone.setProcessor).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("Could not initialize microphone processing; using browser audio", error);
    });

    it("cleans up a failed processor without preventing unmute", async () => {
        const error = new Error("Processor initialization failed");
        const room = { audioContext: {}, acquireAudioContext: vi.fn().mockResolvedValue(undefined) };
        const microphone = { kind: "audio", setProcessor: vi.fn().mockRejectedValue(error) };
        const processor = { destroy: vi.fn().mockResolvedValue(undefined) };
        const warn = vi.fn();
        const tracks = await microphoneTrackFactory(warn)(
            room,
            async () => [microphone],
            {},
            {
                createMicrophoneProcessor: () => processor,
            },
        );
        expect(tracks).toEqual([microphone]);
        expect(processor.destroy).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith("Could not process the microphone; using browser audio", error);
    });
});
