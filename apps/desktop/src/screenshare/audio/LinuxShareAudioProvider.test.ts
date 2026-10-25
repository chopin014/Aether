/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createLinuxAudioCommandEnvironment,
    type LinuxAudioChildProcess,
    type LinuxAudioProcessInfo,
    type LinuxShareAudioDependencies,
} from "./LinuxShareAudioDependencies.js";
import type { LinuxPulseSinkInput } from "./LinuxPulseAudioClient.js";
import type { ShareAudioTarget } from "./types.js";
import { LinuxPcmMixer } from "./LinuxPcmMixer.js";
import { createLinuxShareAudioProvider } from "./LinuxShareAudioProvider.js";

interface TestState {
    inputs: LinuxPulseSinkInput[];
    processes: Map<number, LinuxAudioProcessInfo>;
    children: FakeChildProcess[];
    captures: Array<{ executable: string; args: readonly string[] }>;
    commands: Array<{ executable: string; args: readonly string[] }>;
    nextCaptureFails: boolean;
    nextCapturePcm: Buffer | null | undefined;
    nextCaptureConfirms: boolean;
    nextCaptureIgnoresTerm: boolean;
    windowPid: number;
}

class FakeChildProcess extends EventEmitter {
    public readonly stdout = new PassThrough();
    public readonly stderr = new PassThrough();
    public exitCode: number | null = null;
    public readonly killCalls: string[] = [];

    private readonly ignoreTermination: boolean;

    public constructor(
        pcm: Buffer | null,
        failBeforeReady: boolean,
        confirmsConnection: boolean,
        ignoreTermination: boolean,
    ) {
        super();
        this.ignoreTermination = ignoreTermination;
        queueMicrotask(() => {
            this.emit("spawn");
            if (confirmsConnection) this.stderr.write("Connection established.\nStream successfully created.\n");
            if (failBeforeReady) {
                setTimeout(() => this.finish(1, null), 5);
            } else if (pcm) {
                this.stdout.write(pcm);
            }
        });
    }

    public kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
        this.killCalls.push(String(signal));
        if (signal === "SIGTERM" && this.ignoreTermination) return true;
        queueMicrotask(() => this.finish(0, typeof signal === "string" ? signal : null));
        return true;
    }

    public finish(code: number, signal: NodeJS.Signals | null): void {
        if (this.exitCode !== null) return;
        this.exitCode = code;
        this.stdout.end();
        this.stderr.end();
        this.emit("close", code, signal);
    }
}

const openChildren: FakeChildProcess[] = [];

afterEach(async () => {
    for (const child of openChildren.splice(0)) {
        if (child.exitCode === null) child.kill("SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("LinuxShareAudioProvider", () => {
    it("should force stable UTF-8 CLI output while preserving desktop server variables", () => {
        const environment = createLinuxAudioCommandEnvironment({
            LANG: "pt_BR.UTF-8",
            LC_ALL: "pt_BR.UTF-8",
            PULSE_SERVER: "unix:/run/user/1000/pulse/native",
            DISPLAY: ":0",
        });

        expect(environment.LC_ALL).toBe("C.UTF-8");
        expect(environment.LANG).toBe("pt_BR.UTF-8");
        expect(environment.PULSE_SERVER).toBe("unix:/run/user/1000/pulse/native");
        expect(environment.DISPLAY).toBe(":0");
    });

    it("should exclude application descendants and emit stereo float32le at 48 kHz", async () => {
        const { state, dependencies } = createHarness([
            sinkInput(0, 11, "Browser"),
            sinkInput(102, 21, "Aether"),
            sinkInput(103, null, "Unknown owner"),
            sinkInput(104, 99_999, "Exited process"),
        ]);
        const onData = vi.fn();
        const onError = vi.fn();
        const onStopped = vi.fn();
        const provider = createLinuxShareAudioProvider(dependencies);
        const session = await provider.start({ kind: "system" }, [20], { onData, onError, onStopped });

        expect(state.children).toHaveLength(1);
        expect(
            state.captures.some(
                ({ executable, args }) => executable === "parec" && args.includes("--monitor-stream=0"),
            ),
        ).toBe(true);
        expect(
            state.commands.some(({ executable, args }) => executable === "pactl" && args.includes("move-sink-input")),
        ).toBe(false);
        expect(
            state.commands.some(({ executable, args }) => executable === "pactl" && args.includes("load-module")),
        ).toBe(false);

        await waitFor(() => onData.mock.calls.length > 0);
        const pcm = onData.mock.calls[0][0] as Buffer;
        expect(pcm.length).toBe(480 * 2 * Float32Array.BYTES_PER_ELEMENT);
        expect(pcm.readFloatLE(0)).toBeCloseTo(0.25);
        expect(pcm.readFloatLE(4)).toBeCloseTo(-0.25);
        expect(state.children[0].killCalls).toHaveLength(0);

        await session.stop();
        expect(onStopped).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it("should resolve X11 windows to the owning application process tree", async () => {
        const { dependencies, state } = createHarness([
            sinkInput(201, 11, "Selected app"),
            sinkInput(202, 30, "Other app"),
        ]);
        const provider = createLinuxShareAudioProvider(dependencies);

        const targetId = await provider.resolveWindow("window:77:0");
        expect(targetId).toBe("linux-process:10:100");

        const session = await provider.start({ kind: "application", id: targetId! }, [], {
            onData: vi.fn(),
            onError: vi.fn(),
            onStopped: vi.fn(),
        });
        expect(state.children).toHaveLength(1);
        expect(state.children[0].killCalls).toHaveLength(0);
        await session.stop();
    });

    it("should keep Aether playback excluded from selected-application capture", async () => {
        const { dependencies, state } = createHarness([
            sinkInput(211, 11, "Selected app"),
            sinkInput(212, 12, "Selected app"),
            sinkInput(213, 21, "Aether"),
        ]);
        const provider = createLinuxShareAudioProvider(dependencies);
        const applications = await provider.listApplications();
        const selected = applications.find((application) => application.id === "linux-process:11:111");
        if (!selected) throw new Error("Expected the selected app playback stream to be listed.");

        const session = await provider.start({ kind: "application", id: selected.id }, [20], {
            onData: vi.fn(),
            onError: vi.fn(),
            onStopped: vi.fn(),
        });
        expect(state.children).toHaveLength(2);
        expect(
            state.captures.some(({ executable, args }) => executable === "parec" && args.includes("--latency-msec=10")),
        ).toBe(true);
        await session.stop();
    });

    it("should list current applications with process-start identities", async () => {
        const { dependencies } = createHarness([sinkInput(301, 11, "Browser")]);
        const applications = await createLinuxShareAudioProvider(dependencies).listApplications();

        expect(applications).toEqual([{ id: "linux-process:11:111", name: "Browser" }]);
    });

    it("should reject unknown application targets without starting a process", async () => {
        const { dependencies, state } = createHarness([]);
        const provider = createLinuxShareAudioProvider(dependencies);

        await expect(
            provider.start({ kind: "application", id: "unknown-target" }, [], {
                onData: vi.fn(),
                onError: vi.fn(),
                onStopped: vi.fn(),
            }),
        ).rejects.toThrow("unknown");
        expect(state.children).toHaveLength(0);
    });

    it("should reject malformed audio targets without broadening to system capture", async () => {
        const { dependencies, state } = createHarness([sinkInput(305, 11, "Browser")]);
        const invalidTarget = { kind: "unknown" } as unknown as ShareAudioTarget;

        await expect(
            createLinuxShareAudioProvider(dependencies).start(invalidTarget, [], {
                onData: vi.fn(),
                onError: vi.fn(),
                onStopped: vi.fn(),
            }),
        ).rejects.toThrow("target is unknown");
        expect(state.children).toHaveLength(0);
    });

    it("should report unavailable when pactl cannot return its required JSON stream lists", async () => {
        const { dependencies } = createHarness([]);
        const originalExecute = dependencies.execute;
        dependencies.execute = async (executable, args, timeoutMs) => {
            if (executable === "pactl" && args.join(" ") === "-f json list sink-inputs") return "not-json";
            return originalExecute(executable, args, timeoutMs);
        };

        const capabilities = await createLinuxShareAudioProvider(dependencies).capabilities();
        expect(capabilities.system).toBe(false);
        expect(capabilities.application).toBe(false);
        expect(capabilities.reason).toContain("JSON");
    });

    it("should reject a PulseAudio server too old for per-stream monitoring", async () => {
        const { dependencies } = createHarness([]);
        const originalExecute = dependencies.execute;
        dependencies.execute = async (executable, args, timeoutMs) => {
            if (executable === "pactl" && args[0] === "info") {
                return "Server Name: pulseaudio\nServer Version: 0.9.10";
            }
            return originalExecute(executable, args, timeoutMs);
        };

        const capabilities = await createLinuxShareAudioProvider(dependencies).capabilities();
        expect(capabilities.system).toBe(false);
        expect(capabilities.application).toBe(false);
        expect(capabilities.reason).toContain("0.9.11");
    });

    it("should observe cancellation after daemon availability and before session creation", async () => {
        const { dependencies, state } = createHarness([]);
        const originalExecute = dependencies.execute;
        const controller = new AbortController();
        let notifyInfoStarted!: () => void;
        let releaseInfo!: () => void;
        const infoStarted = new Promise<void>((resolve) => (notifyInfoStarted = resolve));
        const infoGate = new Promise<void>((resolve) => (releaseInfo = resolve));
        dependencies.execute = async (executable, args, timeoutMs) => {
            if (executable === "pactl" && args[0] === "info") {
                notifyInfoStarted();
                await infoGate;
            }
            return originalExecute(executable, args, timeoutMs);
        };

        const starting = createLinuxShareAudioProvider(dependencies).start(
            { kind: "system" },
            [],
            { onData: vi.fn(), onError: vi.fn(), onStopped: vi.fn() },
            controller.signal,
        );
        await infoStarted;
        controller.abort();
        releaseInfo();

        await expect(starting).rejects.toMatchObject({ name: "AbortError" });
        expect(state.children).toHaveLength(0);
    });

    it("should abort and reap parec while initial capture readiness is pending", async () => {
        const { dependencies, state } = createHarness([sinkInput(402, 11, "Browser")]);
        state.nextCapturePcm = null;
        state.nextCaptureIgnoresTerm = true;
        const controller = new AbortController();
        const onError = vi.fn();
        const onStopped = vi.fn();
        const starting = createLinuxShareAudioProvider(dependencies).start(
            { kind: "system" },
            [],
            { onData: vi.fn(), onError, onStopped },
            controller.signal,
        );

        await waitFor(() => state.children.length === 1);
        controller.abort();
        await expect(starting).rejects.toMatchObject({ name: "AbortError" });
        await waitFor(() => onStopped.mock.calls.length === 1);
        expect(state.children[0].killCalls).toEqual(["SIGTERM", "SIGKILL"]);
        expect(onError).not.toHaveBeenCalled();
    });

    it("should reject if parec exits before the initial capture is ready", async () => {
        const { dependencies, state } = createHarness([sinkInput(401, 11, "Browser")]);
        state.nextCaptureFails = true;
        const onError = vi.fn();

        await expect(
            createLinuxShareAudioProvider(dependencies).start({ kind: "system" }, [], {
                onData: vi.fn(),
                onError,
                onStopped: vi.fn(),
            }),
        ).rejects.toThrow("before capture was ready");
        expect(state.children[0].exitCode).toBe(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it("should accept a silent capture only after parec confirms its server connection", async () => {
        const { dependencies, state } = createHarness([sinkInput(451, 11, "Paused app")]);
        state.nextCapturePcm = null;
        state.nextCaptureConfirms = true;

        const session = await createLinuxShareAudioProvider(dependencies).start({ kind: "system" }, [], {
            onData: vi.fn(),
            onError: vi.fn(),
            onStopped: vi.fn(),
        });
        expect(state.children).toHaveLength(1);
        await session.stop();
    });

    it("should reject a capture that never confirms its server connection", async () => {
        const { dependencies, state } = createHarness([sinkInput(452, 11, "Paused app")]);
        state.nextCapturePcm = null;
        dependencies.captureReadyTimeoutMs = 15;

        await expect(
            createLinuxShareAudioProvider(dependencies).start({ kind: "system" }, [], {
                onData: vi.fn(),
                onError: vi.fn(),
                onStopped: vi.fn(),
            }),
        ).rejects.toThrow("did not confirm");
        expect(state.children[0].killCalls).toHaveLength(1);
    });

    it("should add and remove playback streams dynamically", async () => {
        const { dependencies, state } = createHarness([sinkInput(501, 11, "Browser")]);
        const onError = vi.fn();
        const session = await createLinuxShareAudioProvider(dependencies).start({ kind: "system" }, [], {
            onData: vi.fn(),
            onError,
            onStopped: vi.fn(),
        });

        state.inputs.push(sinkInput(502, 30, "Music player"));
        await waitFor(() => state.children.length === 2);
        state.inputs = [sinkInput(502, 30, "Music player")];
        await waitFor(() => state.children[0].killCalls.length === 1);
        expect(onError).not.toHaveBeenCalled();

        await session.stop();
    });

    it("should terminate once when capture stops unexpectedly and stop idempotently", async () => {
        const { dependencies, state } = createHarness([sinkInput(601, 11, "Browser")]);
        const onError = vi.fn();
        const onStopped = vi.fn();
        const session = await createLinuxShareAudioProvider(dependencies).start({ kind: "system" }, [], {
            onData: vi.fn(),
            onError,
            onStopped,
        });

        state.children[0].finish(1, null);
        await waitFor(() => onError.mock.calls.length === 1);
        expect(onStopped).not.toHaveBeenCalled();
        await session.stop();
        await session.stop();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onStopped).not.toHaveBeenCalled();
    });

    it("should wait for an in-flight discovery before stopping and never spawn after cancellation", async () => {
        const { dependencies, state } = createHarness([sinkInput(701, 11, "Browser")]);
        const session = await createLinuxShareAudioProvider(dependencies).start({ kind: "system" }, [], {
            onData: vi.fn(),
            onError: vi.fn(),
            onStopped: vi.fn(),
        });

        const originalExecute = dependencies.execute;
        let notifyQueryStarted!: () => void;
        let releaseQuery!: () => void;
        const queryStarted = new Promise<void>((resolve) => (notifyQueryStarted = resolve));
        const queryGate = new Promise<void>((resolve) => (releaseQuery = resolve));
        let delayNextQuery = true;
        dependencies.execute = async (executable, args, timeoutMs) => {
            if (delayNextQuery && executable === "pactl" && args.join(" ") === "-f json list sink-inputs") {
                delayNextQuery = false;
                notifyQueryStarted();
                await queryGate;
            }
            return originalExecute(executable, args, timeoutMs);
        };

        state.inputs.push(sinkInput(702, 30, "New app"));
        await queryStarted;
        const stopping = session.stop();
        releaseQuery();
        await stopping;
        await new Promise((resolve) => setTimeout(resolve, 350));

        expect(state.children).toHaveLength(1);
        expect(state.children[0].killCalls).toHaveLength(1);
    });

    it("should keep source buffering bounded and discard the oldest frames", async () => {
        const chunks: Buffer[] = [];
        const mixer = new LinuxPcmMixer((pcm) => chunks.push(pcm));
        mixer.addSource("test");
        const input = Buffer.alloc(4_801 * 8);
        for (let frame = 0; frame < 4_801; frame++) {
            input.writeFloatLE(frame / 10_000, frame * 8);
            input.writeFloatLE(0, frame * 8 + 4);
        }
        input.writeFloatLE(Number.NaN, 2 * 8);
        mixer.write("test", input);
        mixer.start();

        await waitFor(() => chunks.length > 0);
        expect(chunks[0].readFloatLE(0)).toBeCloseTo(0.0001);
        expect(chunks[0].readFloatLE(8)).toBe(0);
        mixer.stop();
    });
});

function createHarness(inputs: LinuxPulseSinkInput[]): { dependencies: LinuxShareAudioDependencies; state: TestState } {
    const state: TestState = {
        inputs,
        processes: new Map([
            [1, processInfo(1, 0, "1", "init")],
            [10, processInfo(10, 1, "100", "browser")],
            [11, processInfo(11, 10, "111", "audio-renderer")],
            [12, processInfo(12, 11, "112", "utility")],
            [20, processInfo(20, 1, "200", "aether")],
            [21, processInfo(21, 20, "211", "aether-audio")],
            [30, processInfo(30, 1, "300", "music-player")],
        ]),
        children: [],
        captures: [],
        commands: [],
        nextCaptureFails: false,
        nextCapturePcm: undefined,
        nextCaptureConfirms: false,
        nextCaptureIgnoresTerm: false,
        windowPid: 10,
    };

    const dependencies: LinuxShareAudioDependencies = {
        execute: vi.fn(async (executable: string, args: readonly string[]) => {
            state.commands.push({ executable, args });
            if (executable === "pactl" && args[0] === "info") {
                return "Server Name: PulseAudio (on PipeWire)\nServer Version: 15.0.0";
            }
            if (executable === "parec" && args[0] === "--help") return "--monitor-stream=INDEX --latency-msec=MSEC";
            if (executable === "pactl" && args.join(" ") === "-f json list sink-inputs") {
                return JSON.stringify(
                    state.inputs.map((input) => ({
                        index: input.index,
                        sink: input.sinkIndex,
                        properties: {
                            "application.process.id": input.processId === null ? "" : String(input.processId),
                            "application.name": input.applicationName ?? "",
                        },
                    })),
                );
            }
            if (executable === "pactl" && args.join(" ") === "-f json list sinks") {
                return JSON.stringify([{ index: 1, monitor_source: "test.monitor" }]);
            }
            if (executable === "xprop" && args[0] === "-root") return "_NET_SUPPORTED(ATOM) = _NET_WM_PID";
            if (executable === "xprop" && args[0] === "-id") {
                return `_NET_WM_PID(CARDINAL) = ${state.windowPid}`;
            }
            throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
        }),
        spawn: vi.fn((executable: string, args: readonly string[]) => {
            state.captures.push({ executable, args });
            const fail = state.nextCaptureFails;
            state.nextCaptureFails = false;
            const pcm = state.nextCapturePcm === undefined ? toneFrame(0.25, -0.25) : state.nextCapturePcm;
            state.nextCapturePcm = undefined;
            const confirmsConnection = state.nextCaptureConfirms;
            state.nextCaptureConfirms = false;
            const ignoreTermination = state.nextCaptureIgnoresTerm;
            state.nextCaptureIgnoresTerm = false;
            const child = new FakeChildProcess(pcm, fail, confirmsConnection, ignoreTermination);
            state.children.push(child);
            openChildren.push(child);
            return child as unknown as LinuxAudioChildProcess;
        }),
        readProcessInfo: vi.fn(async (pid: number) => state.processes.get(pid) ?? null),
        environment: { DISPLAY: ":0" },
        xpropExecutable: "xprop",
        pactlExecutable: "pactl",
        parecExecutable: "parec",
    };
    return { dependencies, state };
}

function sinkInput(index: number, processId: number | null, applicationName: string): LinuxPulseSinkInput {
    return { index, sinkIndex: 1, processId, applicationName };
}

function processInfo(pid: number, parentPid: number, startTime: string, name: string): LinuxAudioProcessInfo {
    return { pid, parentPid, startTime, name };
}

function toneFrame(left: number, right: number): Buffer {
    const frame = Buffer.alloc(8);
    frame.writeFloatLE(left, 0);
    frame.writeFloatLE(right, 4);
    return frame;
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the test condition.");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
