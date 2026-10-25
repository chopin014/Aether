/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ShareAudioCallbacks, ShareAudioSession, ShareAudioTarget } from "./types.js";
import type { LinuxAudioChildProcess, LinuxShareAudioDependencies } from "./LinuxShareAudioDependencies.js";
import { LinuxPcmMixer } from "./LinuxPcmMixer.js";
import type { LinuxPulseAudioClient, LinuxPulseSinkInput } from "./LinuxPulseAudioClient.js";
import { readLinuxProcessAncestry } from "./LinuxProcessTree.js";

const POLL_INTERVAL_MS = 300;
const CAPTURE_READY_TIMEOUT_MS = 3000;
const MAX_CAPTURE_STREAMS = 64;

interface LinuxApplicationTarget {
    pid: number;
    startTime: string;
}

interface DesiredCapture {
    key: string;
    input: LinuxPulseSinkInput;
    monitorSource: string;
}

interface ActiveCapture {
    key: string;
    sinkInput: LinuxPulseSinkInput;
    child: LinuxAudioChildProcess;
    ready: Promise<void>;
    intentionalStop: boolean;
    closed: boolean;
}

/** Owns one Linux playback capture session and all child processes it starts. */
export class LinuxShareAudioSession implements ShareAudioSession {
    private readonly dependencies: LinuxShareAudioDependencies;
    private readonly pulse: LinuxPulseAudioClient;
    private readonly target: ShareAudioTarget;
    private readonly excludedProcessIds: ReadonlySet<number>;
    private readonly callbacks: ShareAudioCallbacks;
    private readonly applicationTarget: LinuxApplicationTarget | null;
    private readonly signal: AbortSignal | undefined;
    private readonly abortListener: () => void;
    private readonly captures = new Map<string, ActiveCapture>();
    private readonly mixer: LinuxPcmMixer;
    private state: "starting" | "running" | "stopping" | "stopped" | "failed" = "starting";
    private pollTimer: NodeJS.Timeout | null = null;
    private refreshTask: Promise<void> | null = null;
    private cleanupTask: Promise<void> | null = null;
    private terminalCallbackSent = false;

    public constructor(
        dependencies: LinuxShareAudioDependencies,
        pulse: LinuxPulseAudioClient,
        target: ShareAudioTarget,
        excludedProcessIds: readonly number[],
        callbacks: ShareAudioCallbacks,
        applicationTarget: LinuxApplicationTarget | null,
        signal: AbortSignal | undefined,
    ) {
        this.dependencies = dependencies;
        this.pulse = pulse;
        this.target = target;
        this.excludedProcessIds = new Set(excludedProcessIds.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
        this.callbacks = callbacks;
        this.applicationTarget = applicationTarget;
        this.signal = signal;
        this.abortListener = () => this.handleAbort();
        this.mixer = new LinuxPcmMixer((pcm) => this.emitData(pcm));
        signal?.addEventListener("abort", this.abortListener, { once: true });
    }

    /** Starts capture and waits for each initial parec stream to connect. */
    public async start(): Promise<void> {
        try {
            this.assertNotAborted();
            await this.refresh();
            this.assertNotAborted();
            if ([...this.captures.values()].some((capture) => capture.closed)) {
                throw new Error("A parec capture stream stopped during startup.");
            }
            this.state = "running";
            this.mixer.start();
            this.pollTimer = setInterval(() => {
                void this.refresh().catch((error: unknown) => this.fail(asError(error)));
            }, POLL_INTERVAL_MS);
            this.pollTimer.unref();
        } catch (error) {
            if (this.state === "starting") this.state = "stopping";
            await this.cleanup();
            this.state = "stopped";
            this.removeAbortListener();
            if (this.signal?.aborted) throw abortError();
            throw error;
        }
    }

    /** Stops all capture processes and completes the session once. */
    public async stop(): Promise<void> {
        if (this.state === "stopped" || this.state === "failed") {
            await this.cleanup();
            return;
        }
        if (this.state === "stopping") {
            await this.cleanup();
            return;
        }

        this.state = "stopping";
        await this.cleanup();
        this.state = "stopped";
        this.notifyStopped();
    }

    private refresh(): Promise<void> {
        if (this.refreshTask) return this.refreshTask;
        const refreshTask = this.reconcile();
        this.refreshTask = refreshTask;
        void refreshTask.then(
            () => {
                if (this.refreshTask === refreshTask) this.refreshTask = null;
            },
            () => {
                if (this.refreshTask === refreshTask) this.refreshTask = null;
            },
        );
        return refreshTask;
    }

    private async reconcile(): Promise<void> {
        if (this.state !== "starting" && this.state !== "running") return;

        const [sinkInputs, sinks] = await Promise.all([this.pulse.listSinkInputs(), this.pulse.listSinks()]);
        if (this.state !== "starting" && this.state !== "running") return;
        const sinkByIndex = new Map(sinks.map((sink) => [sink.index, sink]));
        const ancestryByPid = new Map<number, Awaited<ReturnType<typeof readLinuxProcessAncestry>>>();
        const desired = new Map<string, DesiredCapture>();

        for (const input of sinkInputs) {
            if (input.processId === null) continue;
            let ancestry = ancestryByPid.get(input.processId);
            if (ancestry === undefined) {
                ancestry = await readLinuxProcessAncestry(input.processId, this.dependencies);
                ancestryByPid.set(input.processId, ancestry);
            }
            if (this.state !== "starting" && this.state !== "running") return;
            // Missing procfs ownership fails closed for both app isolation and Aether call-audio exclusion.
            if (!ancestry) continue;

            // Exclusions apply to both modes so a selected Aether window cannot capture call playback.
            if (ancestry.some((processInfo) => this.excludedProcessIds.has(processInfo.pid))) continue;

            if (this.target.kind === "application" && !this.belongsToSelectedApplication(ancestry)) {
                continue;
            }

            const monitorSource = sinkByIndex.get(input.sinkIndex)?.monitorSource;
            if (!monitorSource) {
                throw new Error(`Playback stream ${input.index} has no sink monitor source.`);
            }
            const key = `${input.index}:${input.processId}:${input.sinkIndex}`;
            desired.set(key, { key, input, monitorSource });
        }

        if (desired.size > MAX_CAPTURE_STREAMS) {
            throw new Error(`Linux playback capture found more than ${MAX_CAPTURE_STREAMS} eligible audio streams.`);
        }

        await Promise.all(
            [...this.captures.values()]
                .filter((capture) => !desired.has(capture.key))
                .map((capture) => this.stopCapture(capture)),
        );
        if (this.state !== "starting" && this.state !== "running") return;

        const newCaptures: ActiveCapture[] = [];
        for (const item of desired.values()) {
            if (this.state !== "starting" && this.state !== "running") return;
            if (this.captures.has(item.key)) continue;
            newCaptures.push(this.startCapture(item));
        }
        await Promise.all(newCaptures.map((capture) => capture.ready));
    }

    private belongsToSelectedApplication(
        ancestry: NonNullable<Awaited<ReturnType<typeof readLinuxProcessAncestry>>>,
    ): boolean {
        if (!this.applicationTarget) return false;
        return ancestry.some(
            (processInfo) =>
                processInfo.pid === this.applicationTarget?.pid &&
                processInfo.startTime === this.applicationTarget.startTime,
        );
    }

    private startCapture(item: DesiredCapture): ActiveCapture {
        const args = [
            "--record",
            "--raw",
            "--verbose",
            "--format=float32le",
            "--rate=48000",
            "--channels=2",
            "--latency-msec=10",
            "--device",
            item.monitorSource,
            `--monitor-stream=${item.input.index}`,
        ];

        let child: LinuxAudioChildProcess;
        try {
            child = this.dependencies.spawn(this.dependencies.parecExecutable, args);
        } catch (error) {
            throw new Error(`Could not start Linux playback capture: ${errorMessage(error)}`, { cause: error });
        }

        const capture: ActiveCapture = {
            key: item.key,
            sinkInput: item.input,
            child,
            ready: Promise.resolve(),
            intentionalStop: false,
            closed: false,
        };
        this.captures.set(capture.key, capture);
        this.mixer.addSource(capture.key);

        capture.ready = new Promise<void>((resolve, reject) => {
            let ready = false;
            let readyTimer: NodeJS.Timeout | null = null;
            const markReady = (): void => {
                if (ready) return;
                ready = true;
                if (readyTimer) clearTimeout(readyTimer);
                resolve();
            };

            child.stdout.on("data", (chunk: Buffer | string) => {
                const pcm = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                this.mixer.write(capture.key, pcm);
                markReady();
            });
            let stderrTail = "";
            child.stderr.on("data", (chunk: Buffer | string) => {
                stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4096);
                if (/Connection established\.|Stream successfully created\.|Connected to device /i.test(stderrTail)) {
                    markReady();
                }
            });
            child.once("spawn", () => {
                if (ready) return;
                readyTimer = setTimeout(() => {
                    reject(new Error("parec did not confirm its playback capture connection in time."));
                }, this.dependencies.captureReadyTimeoutMs ?? CAPTURE_READY_TIMEOUT_MS);
                readyTimer.unref();
            });
            child.once("error", (error: Error) => {
                capture.closed = true;
                if (readyTimer) clearTimeout(readyTimer);
                if (ready) this.onCaptureFailure(capture, error);
                else reject(new Error(`Could not start parec: ${error.message}`, { cause: error }));
            });
            child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
                capture.closed = true;
                if (readyTimer) clearTimeout(readyTimer);
                if (!ready) {
                    reject(new Error(`parec exited before capture was ready (code ${code ?? signal ?? "unknown"}).`));
                    return;
                }
                if (!capture.intentionalStop)
                    this.onCaptureFailure(capture, new Error("parec capture stream stopped unexpectedly."));
            });
        });
        return capture;
    }

    private onCaptureFailure(capture: ActiveCapture, error: Error): void {
        if (this.state !== "running" || capture.intentionalStop) return;
        void this.pulse.listSinkInputs().then(
            (sinkInputs) => {
                if (this.state !== "running" || capture.intentionalStop) return;
                const stillPresent = sinkInputs.some(
                    (input) =>
                        input.index === capture.sinkInput.index && input.processId === capture.sinkInput.processId,
                );
                if (stillPresent) {
                    this.fail(error);
                    return;
                }
                this.captures.delete(capture.key);
                this.mixer.removeSource(capture.key);
                void this.refresh().catch((refreshError: unknown) => this.fail(asError(refreshError)));
            },
            (queryError: unknown) => this.fail(asError(queryError)),
        );
    }

    private async stopCapture(capture: ActiveCapture): Promise<void> {
        capture.intentionalStop = true;
        if (this.captures.get(capture.key) === capture) this.captures.delete(capture.key);
        this.mixer.removeSource(capture.key);
        if (capture.closed || capture.child.exitCode !== null) return;

        const closed = new Promise<void>((resolve) => capture.child.once("close", () => resolve()));
        capture.child.kill("SIGTERM");
        if (await timeout(closed, 500)) return;
        capture.child.kill("SIGKILL");
        await timeout(closed, 500);
    }

    private emitData(pcm: Buffer): void {
        if (this.state !== "running") return;
        try {
            this.callbacks.onData(pcm);
        } catch (error) {
            this.fail(asError(error));
        }
    }

    private fail(error: Error): void {
        if (this.state !== "running") return;
        this.state = "failed";
        void this.finishFailure(error);
    }

    private async finishFailure(error: Error): Promise<void> {
        try {
            await this.cleanup();
        } catch {
            // Report the capture failure after attempting cleanup, even if a child process does not stop cleanly.
        }
        if (this.terminalCallbackSent) return;
        this.terminalCallbackSent = true;
        safelyCall(() => this.callbacks.onError(error));
    }

    private cleanup(): Promise<void> {
        if (this.cleanupTask) return this.cleanupTask;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.mixer.stop();
        const cleanupTask = (async (): Promise<void> => {
            // Kill current captures before joining discovery so startup cancellation does not wait for readiness timeout.
            const currentStops = [...this.captures.values()].map((capture) => this.stopCapture(capture));
            // A refresh may still be reading procfs or PulseAudio; wait for its state check before taking the child snapshot.
            await Promise.allSettled([...currentStops, this.refreshTask?.catch(() => undefined) ?? Promise.resolve()]);
            const remainingStops = [...this.captures.values()].map((capture) => this.stopCapture(capture));
            await Promise.allSettled(remainingStops);
            this.removeAbortListener();
        })();
        this.cleanupTask = cleanupTask;
        return cleanupTask;
    }

    private handleAbort(): void {
        if (this.state === "starting") {
            this.state = "stopping";
            this.mixer.stop();
            void this.finishAbort();
        } else if (this.state === "running") {
            void this.stop();
        }
    }

    private async finishAbort(): Promise<void> {
        try {
            await this.cleanup();
        } catch {
            // Cancellation still completes if a child process cannot be reaped cleanly.
        }
        this.state = "stopped";
        this.notifyStopped();
    }

    private assertNotAborted(): void {
        if (this.signal?.aborted) throw abortError();
    }

    private removeAbortListener(): void {
        this.signal?.removeEventListener("abort", this.abortListener);
    }

    private notifyStopped(): void {
        if (this.terminalCallbackSent) return;
        this.terminalCallbackSent = true;
        safelyCall(this.callbacks.onStopped);
    }
}

async function timeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null;
    const elapsed = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
    });
    const completed = promise.then(() => true as const);
    const result = await Promise.race([completed, elapsed]);
    if (timer) clearTimeout(timer);
    return result;
}

function safelyCall(callback: () => void): void {
    try {
        callback();
    } catch {
        // Cleanup must finish even if a consumer callback throws.
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
    const error = new Error("Linux playback capture was cancelled.");
    error.name = "AbortError";
    return error;
}
