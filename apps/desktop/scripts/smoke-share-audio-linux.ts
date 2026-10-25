/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { ShareAudioApplication, ShareAudioCallbacks, ShareAudioSession } from "../src/screenshare/audio/types.js";
import type { createLinuxShareAudioProvider } from "../src/screenshare/audio/LinuxShareAudioProvider.js";

type CompiledProviderModule = { createLinuxShareAudioProvider: typeof createLinuxShareAudioProvider };

interface SyntheticPlayer {
    process: ChildProcess;
    applicationName: string;
    stderr: string;
    spawnError: Error | null;
    inputError: Error | null;
}

const SAMPLE_RATE = 48_000;
const CHUNK_BYTES = 480 * 2 * Float32Array.BYTES_PER_ELEMENT;
const CAPTURE_DURATION_SECONDS = 1;
const TONE_DURATION_SECONDS = 6;
const SMOKE_SINK_PREFIX = "aether_share_audio_smoke";

/**
 * Runs the real compiled Linux provider against two generated tones in a temporary null sink.
 *
 * From apps/desktop, compile the provider with `pnpm exec tsc`, then run
 * `node --experimental-strip-types scripts/smoke-share-audio-linux.ts`. The default mode captures only the generated
 * app stream. Pass `--system` only with an explicit private `PULSE_SERVER` endpoint. Set
 * `AETHER_SHARE_AUDIO_PROVIDER_MODULE` to a compiled module path when testing a subset build outside `lib/`.
 */
async function main(): Promise<void> {
    if (process.platform !== "linux") throw new Error("This smoke test can only run on Linux.");
    const mode = process.argv.includes("--system") ? "system" : "application";
    const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--system");
    if (unexpectedArguments.length > 0) {
        throw new Error("Usage: node --experimental-strip-types scripts/smoke-share-audio-linux.ts [--system]");
    }
    if (mode === "system" && !process.env.PULSE_SERVER?.trim()) {
        throw new Error("System capture smoke requires PULSE_SERVER to name a private PulseAudio server.");
    }

    const abortController = new AbortController();
    const abortForSignal = (): void => abortController.abort();
    process.once("SIGINT", abortForSignal);
    process.once("SIGTERM", abortForSignal);

    const defaultSinkBefore = await execute("pactl", ["get-default-sink"]);
    const sinkName = `${SMOKE_SINK_PREFIX}_${process.pid}`;
    let moduleId: string | null = null;
    let session: ShareAudioSession | null = null;
    const players: SyntheticPlayer[] = [];
    let defaultSinkAfter: string | null = null;
    let nullSinkRemoved = false;
    let parecProcessesReaped = false;
    let playersReaped = false;
    let outputSummary: Record<string, number | string | boolean> | null = null;
    let operationFailed = false;
    let operationError: unknown;
    const cleanupErrors: Error[] = [];

    try {
        moduleId = await execute("pactl", [
            "load-module",
            "module-null-sink",
            `sink_name=${sinkName}`,
            "format=float32le",
            `rate=${SAMPLE_RATE}`,
            "channels=2",
        ]);
        if (!/^\d+$/.test(moduleId)) throw new Error(`pactl returned an invalid null-sink module ID: ${moduleId}`);

        const providerUrl = process.env.AETHER_SHARE_AUDIO_PROVIDER_MODULE
            ? pathToFileURL(path.resolve(process.env.AETHER_SHARE_AUDIO_PROVIDER_MODULE))
            : new URL("../lib/screenshare/audio/LinuxShareAudioProvider.js", import.meta.url);
        const providerModule = (await import(providerUrl.href)) as CompiledProviderModule;
        const provider = providerModule.createLinuxShareAudioProvider();
        const capabilities = await provider.capabilities();
        if (!capabilities.system || !capabilities.application) {
            throw new Error(`Linux share-audio provider is unavailable: ${capabilities.reason ?? "unknown reason"}`);
        }

        players.push(await startSyntheticPlayer(sinkName, "AetherShareSmoke440", 440));
        players.push(await startSyntheticPlayer(sinkName, "AetherShareSmoke880", 880));
        const player440 = players[0];
        const player880 = players[1];
        const player440Pid = requirePid(player440);
        const player880Pid = requirePid(player880);

        let applications: ShareAudioApplication[] = [];
        await waitFor(
            async () => {
                applications = await provider.listApplications();
                return (
                    applications.some((application) => application.name === player440.applicationName) &&
                    applications.some((application) => application.name === player880.applicationName)
                );
            },
            5000,
            abortController.signal,
        );
        const target = applications.find((application) => application.name === player440.applicationName);
        if (!target) throw new Error(`Provider did not list ${player440.applicationName}.`);

        const capturedChunks: Buffer[] = [];
        let capturedBytes = 0;
        let captureError: Error | null = null;
        let targetToneObserved = false;
        let stoppedCallback = false;
        const callbacks: ShareAudioCallbacks = {
            onData: (pcm) => {
                if (captureError) return;
                if (pcm.length !== CHUNK_BYTES) {
                    captureError = new Error(
                        `Provider emitted a ${pcm.length}-byte PCM frame; expected ${CHUNK_BYTES}.`,
                    );
                    return;
                }
                // PulseAudio can confirm a monitor stream before playback reaches its first buffer. Start the
                // verification window when the expected synthetic tone is actually present, not on initial silence.
                if (!targetToneObserved) {
                    targetToneObserved =
                        frequencyMagnitude(pcm, 0, 440) > 0.05 && frequencyMagnitude(pcm, 1, 440) > 0.05;
                    if (!targetToneObserved) return;
                }
                if (capturedBytes >= 2 * 1024 * 1024) {
                    captureError = new Error("Provider emitted more than the bounded synthetic PCM capture window.");
                    return;
                }
                capturedChunks.push(Buffer.from(pcm));
                capturedBytes += pcm.length;
            },
            onError: (error) => {
                captureError = error;
            },
            onStopped: () => {
                stoppedCallback = true;
            },
        };

        const captureTarget =
            mode === "system" ? { kind: "system" as const } : { kind: "application" as const, id: target.id };
        session = await provider.start(captureTarget, [player880Pid], callbacks, abortController.signal);
        await waitFor(
            async () => {
                if (captureError) throw captureError;
                return capturedBytes >= SAMPLE_RATE * 2 * Float32Array.BYTES_PER_ELEMENT * CAPTURE_DURATION_SECONDS;
            },
            5000,
            abortController.signal,
        );
        const playerPids = new Set([player440Pid, player880Pid]);
        const ownedParecProcesses = await listOwnedParecChildren(playerPids);
        if (ownedParecProcesses.size === 0)
            throw new Error("Could not identify the provider's live parec child process.");

        await session.stop();
        session = null;
        if (!stoppedCallback) throw new Error("Provider stop did not deliver its stopped callback.");

        await waitFor(
            async () => {
                const remainingPids = await listOwnedParecChildren(playerPids);
                parecProcessesReaped = [...ownedParecProcesses].every((pid) => !remainingPids.has(pid));
                return parecProcessesReaped;
            },
            2000,
            abortController.signal,
        );

        const pcm = Buffer.concat(capturedChunks);
        outputSummary = verifyPcm(pcm);
        outputSummary.application = target.name;
        outputSummary.mode = mode;
        outputSummary.selectedPlayerPid = player440Pid;
        outputSummary.excludedPlayerPid = player880Pid;
        outputSummary.providerParecProcesses = ownedParecProcesses.size;
    } catch (error) {
        operationFailed = true;
        operationError = error;
    } finally {
        if (session) {
            try {
                await session.stop();
            } catch (error) {
                cleanupErrors.push(asError(error));
            }
        }
        for (const player of players) {
            try {
                await stopChild(player.process);
            } catch (error) {
                cleanupErrors.push(asError(error));
            }
        }
        playersReaped = players.every(
            (player) => player.process.exitCode !== null || player.process.signalCode !== null,
        );
        if (!playersReaped) cleanupErrors.push(new Error("A synthetic pacat player remained after cleanup."));

        if (moduleId) {
            try {
                await execute("pactl", ["unload-module", moduleId]);
            } catch (error) {
                cleanupErrors.push(asError(error));
            }
        }
        try {
            const sinks = parseJsonArray(await execute("pactl", ["-f", "json", "list", "sinks"]));
            nullSinkRemoved = !sinks.some((value) => record(value)?.name === sinkName);
            defaultSinkAfter = await execute("pactl", ["get-default-sink"]);
            if (!nullSinkRemoved) cleanupErrors.push(new Error(`Temporary null sink ${sinkName} was not removed.`));
            if (defaultSinkBefore !== defaultSinkAfter)
                cleanupErrors.push(new Error("The smoke test changed the default output device."));
        } catch (error) {
            cleanupErrors.push(asError(error));
        }
        process.removeListener("SIGINT", abortForSignal);
        process.removeListener("SIGTERM", abortForSignal);
    }

    if (operationFailed && cleanupErrors.length > 0) {
        throw new AggregateError(
            [asError(operationError), ...cleanupErrors],
            "Linux share-audio smoke operation and cleanup failed.",
        );
    }
    if (operationFailed) throw operationError;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Linux share-audio smoke cleanup failed.");

    if (defaultSinkBefore !== defaultSinkAfter) throw new Error("The smoke test changed the default output device.");
    if (!nullSinkRemoved) throw new Error(`Temporary null sink ${sinkName} was not removed.`);
    if (!parecProcessesReaped) throw new Error("Provider-owned parec capture process remained after stop.");
    if (!playersReaped) throw new Error("Synthetic pacat players remained after stop.");
    if (!outputSummary) throw new Error("Provider did not emit synthetic PCM.");

    process.stdout.write(
        `${JSON.stringify({
            ok: true,
            defaultSinkUnchanged: true,
            nullSinkRemoved,
            parecProcessesReaped,
            playersReaped,
            ...outputSummary,
        })}\n`,
    );
}

async function startSyntheticPlayer(
    sinkName: string,
    applicationName: string,
    frequency: number,
): Promise<SyntheticPlayer> {
    const playerProcess = spawn(
        "pacat",
        [
            "--playback",
            "--raw",
            "--format=s16le",
            `--rate=${SAMPLE_RATE}`,
            "--channels=2",
            `--device=${sinkName}`,
            `--property=application.name=${applicationName}`,
            `--stream-name=${applicationName}`,
        ],
        {
            stdio: ["pipe", "ignore", "pipe"],
            windowsHide: true,
            env: stableCommandEnvironment(),
        },
    );
    const player: SyntheticPlayer = {
        process: playerProcess,
        applicationName,
        stderr: "",
        spawnError: null,
        inputError: null,
    };
    playerProcess.once("error", (error) => {
        player.spawnError = error;
    });
    playerProcess.stderr?.on("data", (chunk: Buffer | string) => {
        player.stderr = `${player.stderr}${chunk.toString()}`.slice(-2048);
    });

    await waitFor(async () => {
        if (player.spawnError) throw player.spawnError;
        if (playerProcess.exitCode !== null) throw new Error(`pacat exited early: ${player.stderr}`);
        return playerProcess.pid !== undefined;
    }, 3000);
    if (!playerProcess.stdin) throw new Error("pacat stdin was not available.");
    playerProcess.stdin.on("error", (error) => {
        player.inputError = error;
    });
    playerProcess.stdin.end(makeTone(frequency, TONE_DURATION_SECONDS));
    return player;
}

function makeTone(frequency: number, durationSeconds: number): Buffer {
    const frameCount = SAMPLE_RATE * durationSeconds;
    const pcm = Buffer.allocUnsafe(frameCount * 2 * Int16Array.BYTES_PER_ELEMENT);
    const amplitude = 0.25 * 32_767;
    for (let frame = 0; frame < frameCount; frame++) {
        const sample = Math.round(Math.sin((2 * Math.PI * frequency * frame) / SAMPLE_RATE) * amplitude);
        const offset = frame * 2 * Int16Array.BYTES_PER_ELEMENT;
        pcm.writeInt16LE(sample, offset);
        pcm.writeInt16LE(sample, offset + Int16Array.BYTES_PER_ELEMENT);
    }
    return pcm;
}

function verifyPcm(pcm: Buffer): Record<string, number | string | boolean> {
    if (pcm.length === 0 || pcm.length % CHUNK_BYTES !== 0) {
        throw new Error(`Captured ${pcm.length} bytes, which is not a sequence of 10 ms stereo float32 frames.`);
    }

    const left440 = frequencyMagnitude(pcm, 0, 440);
    const right440 = frequencyMagnitude(pcm, 1, 440);
    const left880 = frequencyMagnitude(pcm, 0, 880);
    const right880 = frequencyMagnitude(pcm, 1, 880);
    if (left440 < 0.05 || right440 < 0.05) {
        throw new Error(`Selected 440 Hz app tone was not present in both stereo channels (${left440}, ${right440}).`);
    }
    if (left880 > left440 * 0.15 || right880 > right440 * 0.15) {
        throw new Error(`Excluded 880 Hz app tone leaked into selected-app capture (${left880}, ${right880}).`);
    }

    return {
        bytes: pcm.length,
        chunks: pcm.length / CHUNK_BYTES,
        format: "48 kHz stereo float32le",
        left440Magnitude: Number(left440.toFixed(4)),
        right440Magnitude: Number(right440.toFixed(4)),
        left880Leakage: Number(left880.toFixed(4)),
        right880Leakage: Number(right880.toFixed(4)),
    };
}

function frequencyMagnitude(pcm: Buffer, channel: 0 | 1, frequency: number): number {
    const frameCount = pcm.length / (2 * Float32Array.BYTES_PER_ELEMENT);
    const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / SAMPLE_RATE);
    let previous = 0;
    let previousPrevious = 0;
    for (let frame = 0; frame < frameCount; frame++) {
        const sample = pcm.readFloatLE(
            frame * 2 * Float32Array.BYTES_PER_ELEMENT + channel * Float32Array.BYTES_PER_ELEMENT,
        );
        const current = sample + coefficient * previous - previousPrevious;
        previousPrevious = previous;
        previous = current;
    }
    const power = Math.max(
        0,
        previous * previous + previousPrevious * previousPrevious - coefficient * previous * previousPrevious,
    );
    return (2 * Math.sqrt(power)) / frameCount;
}

async function listOwnedParecChildren(excludedPids: ReadonlySet<number>): Promise<Set<number>> {
    const childList = await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8");
    const pids = new Set<number>();
    for (const token of childList.trim().split(/\s+/)) {
        const pid = Number(token);
        if (!Number.isSafeInteger(pid) || pid <= 0 || excludedPids.has(pid)) continue;
        try {
            const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
            if (command === "parec") pids.add(pid);
        } catch {
            // A command may exit between reading the child list and procfs.
        }
    }
    return pids;
}

async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    if (await resolvesWithin(closed, 500)) return;
    child.kill("SIGKILL");
    await resolvesWithin(closed, 500);
}

async function resolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([promise.then(() => true as const), timeoutPromise]);
    if (timer) clearTimeout(timer);
    return result;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal?.aborted) throw abortError();
        if (await predicate()) return;
        await delay(25, undefined, { signal });
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for Linux share-audio smoke readiness.`);
}

function requirePid(player: SyntheticPlayer): number {
    if (player.process.pid === undefined) throw new Error(`${player.applicationName} has no process ID.`);
    return player.process.pid;
}

function parseJsonArray(output: string): unknown[] {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) throw new Error("pactl did not return a JSON array.");
    return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function execute(executable: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            [...args],
            {
                encoding: "utf8",
                timeout: 5000,
                maxBuffer: 1024 * 1024,
                env: stableCommandEnvironment(),
            },
            (error, stdout) => {
                if (error)
                    reject(new Error(`${executable} ${args.join(" ")} failed: ${error.message}`, { cause: error }));
                else resolve(stdout.trim());
            },
        );
    });
}

function stableCommandEnvironment(): NodeJS.ProcessEnv {
    return { ...process.env, LC_ALL: "C.UTF-8" };
}

function abortError(): Error {
    const error = new Error("Linux share-audio smoke was interrupted.");
    error.name = "AbortError";
    return error;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

void main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Linux share-audio smoke failed: ${detail}\n`);
    process.exitCode = 1;
});
