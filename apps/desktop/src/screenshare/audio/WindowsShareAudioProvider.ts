/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type {
    ShareAudioApplication,
    ShareAudioCapabilities,
    ShareAudioCallbacks,
    ShareAudioProvider,
    ShareAudioSession,
    ShareAudioTarget,
} from "./types.js";

const PCM_FRAME_BYTES = 8;
const MAX_CONTROL_LINE_CHARS = 64 * 1024;
const MAX_TARGETS = 512;
const TARGET_TTL_MS = 15 * 60 * 1000;
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;

interface WindowsAudioSource {
    id: string;
    name: string;
}

/** Windows helper, desktop-capturer and lifecycle dependencies for provider creation. */
export interface WindowsShareAudioProviderOptions {
    /** Absolute path to the packaged native helper executable. */
    helperPath: string;
    /** Supplies current Electron window sources for application choices. */
    listWindows?: () => Promise<WindowsAudioSource[]>;
    /** Overrides the host platform in unit tests. */
    platform?: NodeJS.Platform;
    /** Checks helper presence; injectable so capability detection can be tested. */
    helperExists?: (helperPath: string) => Promise<boolean>;
    /** Starts the helper; injectable so process protocol handling can be tested. */
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    /** Time to wait for the helper's ready message. */
    startTimeoutMs?: number;
    /** Time to wait for one-shot helper queries. */
    queryTimeoutMs?: number;
    /** Time to wait for graceful shutdown before forcing the helper to exit. */
    stopTimeoutMs?: number;
    /** Time to wait for the forced helper exit notification. */
    killTimeoutMs?: number;
}

interface HelperMessage {
    type?: string;
    supported?: boolean;
    build?: number;
    reason?: string;
    valid?: boolean;
    pid?: number;
    creationTime?: string;
    message?: string;
}

interface WindowsAudioProcessTarget {
    pid: number;
    creationTime: string;
    processKey: string;
    lastSeen: number;
}

/**
 * Creates the Windows process-loopback provider. App and window targets are captured by their owning process tree;
 * the provider rejects Aether's own process tree and never widens a failed app capture to system audio.
 */
export function createWindowsShareAudioProvider(options: WindowsShareAudioProviderOptions): ShareAudioProvider {
    const platform = options.platform ?? process.platform;
    const spawnProcess = options.spawn ?? nodeSpawn;
    const helperExists = options.helperExists ?? defaultHelperExists;
    const targetsById = new Map<string, WindowsAudioProcessTarget>();
    const targetIdsByProcess = new Map<string, string>();

    let capabilitiesPromise: Promise<ShareAudioCapabilities> | undefined;
    let applicationsPromise: Promise<ShareAudioApplication[]> | undefined;

    const runQuery = async (args: string[]): Promise<HelperMessage> => {
        const child = spawnProcess(options.helperPath, args, {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
        const stderrStream = child.stderr;
        if (!stderrStream) {
            killChild(child);
            throw new Error("Windows audio helper stderr is unavailable.");
        }

        return await new Promise<HelperMessage>((resolve, reject) => {
            let stderr = "";
            let response: HelperMessage | undefined;
            let settled = false;

            const timer = setTimeout(() => {
                fail(new Error("Windows audio helper query timed out"));
                killChild(child);
            }, options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);

            function fail(error: Error): void {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            }

            stderrStream.on("error", (error) => {
                fail(new Error(`Windows audio helper query stream failed: ${toErrorMessage(error)}`));
                killChild(child);
            });

            stderrStream.on("data", (chunk: Buffer) => {
                if (settled) return;
                stderr += chunk.toString("utf8");
                if (stderr.length > MAX_CONTROL_LINE_CHARS) {
                    fail(new Error("Windows audio helper returned an oversized control message"));
                    killChild(child);
                    return;
                }

                let lineEnd = stderr.indexOf("\n");
                while (lineEnd >= 0) {
                    const line = stderr.slice(0, lineEnd).trim();
                    stderr = stderr.slice(lineEnd + 1);
                    if (line) {
                        if (response !== undefined) {
                            fail(new Error("Windows audio helper returned multiple query messages"));
                            killChild(child);
                            return;
                        }
                        try {
                            response = JSON.parse(line) as HelperMessage;
                        } catch {
                            fail(new Error("Windows audio helper returned invalid JSON"));
                            killChild(child);
                            return;
                        }
                    }
                    lineEnd = stderr.indexOf("\n");
                }
            });

            child.once("error", (error) => {
                fail(error);
                killChild(child);
            });
            child.once("close", (code) => {
                if (settled) return;
                if (stderr.trim()) {
                    fail(new Error("Windows audio helper returned an unterminated query message"));
                    killChild(child);
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (code !== 0 || response === undefined) {
                    reject(new Error(response?.message ?? "Windows audio helper query failed"));
                    return;
                }
                resolve(response);
            });
        });
    };

    const getCapabilities = (): Promise<ShareAudioCapabilities> => {
        if (capabilitiesPromise) return capabilitiesPromise;

        capabilitiesPromise = (async () => {
            if (platform !== "win32") {
                return {
                    system: false,
                    application: false,
                    window: false,
                    reason: "Windows process-loopback audio is available only on Windows.",
                };
            }

            if (!(await helperExists(options.helperPath))) {
                return {
                    system: false,
                    application: false,
                    window: false,
                    reason: "The Windows share-audio helper is missing.",
                };
            }

            try {
                const helper = await runQuery(["--capabilities"]);
                if (
                    helper.type !== "capabilities" ||
                    typeof helper.supported !== "boolean" ||
                    typeof helper.build !== "number" ||
                    !Number.isSafeInteger(helper.build) ||
                    (helper.supported && helper.build < 20348)
                ) {
                    throw new Error("The Windows audio helper returned invalid capability data.");
                }
                if (!helper.supported) {
                    return {
                        system: false,
                        application: false,
                        window: false,
                        reason: helper.reason ?? "Windows 10 build 20348 or later is required.",
                    };
                }

                return { system: true, application: true, window: true };
            } catch (error) {
                return {
                    system: false,
                    application: false,
                    window: false,
                    reason: `The Windows share-audio helper could not start: ${toErrorMessage(error)}`,
                };
            }
        })();

        return capabilitiesPromise;
    };

    const removeTarget = (id: string): void => {
        const target = targetsById.get(id);
        if (!target) return;
        targetsById.delete(id);
        if (targetIdsByProcess.get(target.processKey) === id) targetIdsByProcess.delete(target.processKey);
    };

    const pruneExpiredTargets = (now: number = Date.now()): void => {
        for (const [id, target] of targetsById) {
            if (now - target.lastSeen > TARGET_TTL_MS) removeTarget(id);
        }
    };

    const getOrCreateTargetId = (pid: number, creationTime: string): string => {
        const processKey = `${pid}:${creationTime}`;
        const now = Date.now();
        pruneExpiredTargets(now);

        const existingId = targetIdsByProcess.get(processKey);
        if (existingId) {
            const target = targetsById.get(existingId);
            if (target) {
                target.lastSeen = now;
                targetsById.delete(existingId);
                targetsById.set(existingId, target);
                return existingId;
            }
        }

        const id = randomUUID();
        targetIdsByProcess.set(processKey, id);
        targetsById.set(id, { pid, creationTime, processKey, lastSeen: now });
        while (targetsById.size > MAX_TARGETS) {
            const oldestId = targetsById.keys().next().value;
            if (oldestId === undefined) break;
            removeTarget(oldestId);
        }
        return id;
    };

    const resolveSource = async (sourceId: string): Promise<{ pid: number; creationTime: string } | null> => {
        if (!/^window:\d+(?::[^\r\n]*)?$/.test(sourceId)) return null;

        const helper = await runQuery(["--resolve-window", sourceId]);
        if (
            helper.type !== "resolved" ||
            !helper.valid ||
            !Number.isSafeInteger(helper.pid) ||
            !helper.pid ||
            !helper.creationTime ||
            !/^[\da-fA-F]{1,16}$/.test(helper.creationTime)
        ) {
            return null;
        }
        return { pid: helper.pid, creationTime: helper.creationTime.toLowerCase() };
    };

    const listApplications = (): Promise<ShareAudioApplication[]> => {
        if (applicationsPromise) return applicationsPromise;

        const pending = (async () => {
            try {
                const capabilities = await getCapabilities();
                if (!capabilities.application || !options.listWindows) {
                    for (const id of targetsById.keys()) removeTarget(id);
                    return [];
                }

                const sources = await options.listWindows();
                const applicationsByPid = new Map<number, ShareAudioApplication>();
                const activeProcessKeys = new Set<string>();
                for (const source of sources) {
                    const target = await resolveSource(source.id);
                    if (target === null) continue;
                    const processKey = `${target.pid}:${target.creationTime}`;
                    activeProcessKeys.add(processKey);
                    if (applicationsByPid.has(target.pid)) continue;

                    applicationsByPid.set(target.pid, {
                        id: getOrCreateTargetId(target.pid, target.creationTime),
                        name: source.name,
                    });
                }
                for (const [id, target] of targetsById) {
                    if (!activeProcessKeys.has(target.processKey)) removeTarget(id);
                }
                return [...applicationsByPid.values()];
            } finally {
                applicationsPromise = undefined;
            }
        })();
        applicationsPromise = pending;
        return pending;
    };

    return {
        capabilities: getCapabilities,
        listApplications,
        resolveWindow: async (sourceId: string): Promise<string | null> => {
            if (!(await getCapabilities()).window) return null;
            const target = await resolveSource(sourceId);
            return target === null ? null : getOrCreateTargetId(target.pid, target.creationTime);
        },
        start: async (
            target: ShareAudioTarget,
            excludedProcessIds: readonly number[],
            callbacks: ShareAudioCallbacks,
            signal?: AbortSignal,
        ): Promise<ShareAudioSession> => {
            throwIfAborted(signal);
            const capabilities = await getCapabilities();
            throwIfAborted(signal);
            if (!capabilities[target.kind === "system" ? "system" : target.kind]) {
                throw new Error(capabilities.reason ?? "Windows share-audio capture is not available.");
            }

            let args: string[];
            if (target.kind === "system") {
                const rootProcessId = excludedProcessIds[0];
                if (!Number.isSafeInteger(rootProcessId) || rootProcessId <= 0) {
                    throw new Error("System audio capture requires Aether's root process ID to exclude.");
                }
                args = ["--exclude-tree", String(rootProcessId)];
            } else {
                pruneExpiredTargets();
                const processTarget = targetsById.get(target.id);
                if (!processTarget) throw new Error("The selected Windows audio application is no longer available.");
                processTarget.lastSeen = Date.now();
                args = ["--include-tree", String(processTarget.pid), processTarget.creationTime];
            }

            const child = spawnProcess(options.helperPath, args, {
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
            const stdinStream = child.stdin;
            const stdoutStream = child.stdout;
            const stderrStream = child.stderr;
            if (!stdinStream || !stdoutStream || !stderrStream) {
                killChild(child);
                throw new Error("Windows audio helper streams are unavailable.");
            }
            stdoutStream.pause();

            let ready = false;
            let terminal = false;
            let startSettled = false;
            let stopRequested = false;
            let stderr = "";
            let trailingPcm = Buffer.alloc(0);
            let closeResolve: (() => void) | undefined;
            const closed = new Promise<void>((resolve) => {
                closeResolve = resolve;
            });
            let stopPromise: Promise<void> | undefined;
            let startTimer: NodeJS.Timeout | undefined;
            let abortListener: (() => void) | undefined;

            const clearStartTimer = (): void => {
                if (startTimer) clearTimeout(startTimer);
                startTimer = undefined;
            };

            const clearAbortListener = (): void => {
                if (!signal || !abortListener) return;
                signal.removeEventListener("abort", abortListener);
                abortListener = undefined;
            };

            let startResolve: (session: ShareAudioSession) => void;
            let startReject: (error: Error) => void;
            const started = new Promise<ShareAudioSession>((resolve, reject) => {
                startResolve = resolve;
                startReject = reject;
            });

            const destroyCaptureStreams = (): void => {
                safeCall(() => stdinStream.destroy());
                safeCall(() => stdoutStream.destroy());
                safeCall(() => stderrStream.destroy());
            };

            const emitError = (message: string): void => {
                if (terminal) return;
                terminal = true;
                clearAbortListener();
                if (!ready && !startSettled) {
                    startSettled = true;
                    clearStartTimer();
                    startReject(new Error(message));
                } else {
                    safeCall(() => callbacks.onError(new Error(message)));
                }
                killChild(child);
                destroyCaptureStreams();
            };

            const reportError = (message: string): void => {
                if (terminal || stopRequested) return;
                emitError(message);
            };

            stdinStream.on("error", () => undefined);
            stdoutStream.on("error", (error) => reportError(toErrorMessage(error)));
            stderrStream.on("error", (error) => reportError(toErrorMessage(error)));

            stderrStream.on("data", (chunk: Buffer) => {
                if (terminal || stopRequested) return;
                stderr += chunk.toString("utf8");
                if (stderr.length > MAX_CONTROL_LINE_CHARS) {
                    reportError("Windows audio helper returned an oversized control message");
                    return;
                }

                let lineEnd = stderr.indexOf("\n");
                while (lineEnd >= 0) {
                    const line = stderr.slice(0, lineEnd).trim();
                    stderr = stderr.slice(lineEnd + 1);
                    if (line) {
                        let message: HelperMessage;
                        try {
                            message = JSON.parse(line) as HelperMessage;
                        } catch {
                            reportError("Windows audio helper returned invalid JSON");
                            return;
                        }

                        if (message.type === "error") {
                            reportError(message.message ?? "Windows audio capture failed");
                            return;
                        }
                        if (message.type === "ready" && !ready) {
                            ready = true;
                            startSettled = true;
                            clearStartTimer();
                            clearAbortListener();
                            startResolve({
                                stop: (): Promise<void> => {
                                    if (stopPromise) return stopPromise;
                                    stopPromise = (async () => {
                                        if (terminal) {
                                            await waitForClose(
                                                closed,
                                                options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
                                            );
                                            return;
                                        }
                                        stopRequested = true;
                                        safeCall(() => {
                                            stdinStream.write("stop\n");
                                            stdinStream.end();
                                        });
                                        if (
                                            await waitForClose(closed, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
                                        ) {
                                            return;
                                        }

                                        killChild(child);
                                        if (
                                            !(await waitForClose(
                                                closed,
                                                options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
                                            ))
                                        ) {
                                            terminal = true;
                                            destroyCaptureStreams();
                                            safeCall(() =>
                                                callbacks.onError(
                                                    new Error(
                                                        "Windows audio helper did not exit after being terminated.",
                                                    ),
                                                ),
                                            );
                                        }
                                    })();
                                    return stopPromise;
                                },
                            });
                            stdoutStream.resume();
                        }
                    }
                    lineEnd = stderr.indexOf("\n");
                }
            });

            stdoutStream.on("data", (chunk: Buffer) => {
                if (terminal || stopRequested) return;
                const combined = trailingPcm.length > 0 ? Buffer.concat([trailingPcm, chunk]) : chunk;
                const usableLength = combined.length - (combined.length % PCM_FRAME_BYTES);
                trailingPcm = Buffer.from(combined.subarray(usableLength));
                if (usableLength > 0) {
                    try {
                        callbacks.onData(combined.subarray(0, usableLength));
                    } catch (error) {
                        reportError(`The Windows audio data callback failed: ${toErrorMessage(error)}`);
                    }
                }
            });

            child.once("error", (error) => reportError(toErrorMessage(error)));
            child.once("close", (code) => {
                clearStartTimer();
                clearAbortListener();
                closeResolve?.();
                if (!ready && !startSettled) {
                    terminal = true;
                    startSettled = true;
                    startReject(new Error("Windows audio helper exited before capture was ready."));
                    return;
                }
                if (terminal) return;
                if (trailingPcm.length > 0 && !stopRequested) {
                    reportError("Windows audio helper ended with an incomplete PCM frame.");
                    return;
                }
                if (code !== 0 && !stopRequested) {
                    reportError(`Windows audio helper exited with code ${code ?? "unknown"}.`);
                    return;
                }
                if (code !== 0 && stopRequested) {
                    emitError(`Windows audio helper exited with code ${code ?? "unknown"} while stopping.`);
                    return;
                }
                terminal = true;
                safeCall(callbacks.onStopped);
            });

            if (signal) {
                abortListener = (): void => {
                    if (ready || terminal) return;
                    terminal = true;
                    stopRequested = true;
                    startSettled = true;
                    clearStartTimer();
                    clearAbortListener();
                    killChild(child);
                    destroyCaptureStreams();
                    startReject(createAbortError(signal.reason));
                };
                signal.addEventListener("abort", abortListener, { once: true });
                if (signal.aborted) abortListener();
            }

            if (!terminal) {
                startTimer = setTimeout(() => {
                    reportError("Windows audio helper did not become ready in time.");
                }, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
            }

            return await started;
        },
    };
}

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        void closed.then(() => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw createAbortError(signal.reason);
}

function createAbortError(reason: unknown): Error {
    const message = reason instanceof Error ? reason.message : "Windows audio capture start was cancelled.";
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

async function defaultHelperExists(helperPath: string): Promise<boolean> {
    try {
        await access(helperPath);
        return true;
    } catch {
        return false;
    }
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function safeCall(callback: () => void): void {
    try {
        callback();
    } catch {
        // Callbacks run inside stream and child-process event handlers; they must not interrupt resource cleanup.
    }
}

function killChild(child: ChildProcess): void {
    try {
        child.kill();
    } catch {
        // Continue stream and listener cleanup even if the child process is already unavailable.
    }
}
