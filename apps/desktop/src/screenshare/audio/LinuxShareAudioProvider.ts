/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { execFile, spawn as spawnChild } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ShareAudioApplication, ShareAudioCapabilities, ShareAudioProvider, ShareAudioTarget } from "./types.js";
import { LinuxPulseAudioClient } from "./LinuxPulseAudioClient.js";
import {
    createLinuxAudioCommandEnvironment,
    type LinuxAudioProcessInfo,
    type LinuxShareAudioDependencies,
} from "./LinuxShareAudioDependencies.js";
import { LinuxShareAudioSession } from "./LinuxShareAudioSession.js";

export type { LinuxShareAudioDependencies } from "./LinuxShareAudioDependencies.js";

/** Creates the Linux PulseAudio/PipeWire playback capture provider. */
export function createLinuxShareAudioProvider(
    dependencies: LinuxShareAudioDependencies = createDefaultDependencies(),
): ShareAudioProvider {
    const pulse = new LinuxPulseAudioClient(dependencies);

    return {
        capabilities: async (): Promise<ShareAudioCapabilities> => {
            try {
                await pulse.assertAvailable();
                return {
                    system: true,
                    application: true,
                    window: await canResolveX11Windows(dependencies),
                };
            } catch (error) {
                return {
                    system: false,
                    application: false,
                    window: false,
                    reason: errorMessage(error),
                };
            }
        },
        listApplications: async (): Promise<ShareAudioApplication[]> => {
            await pulse.assertAvailable();
            const inputs = await pulse.listSinkInputs();
            const applications = new Map<number, ShareAudioApplication>();
            for (const input of inputs) {
                if (input.processId === null || applications.has(input.processId)) continue;
                const processInfo = await dependencies.readProcessInfo(input.processId);
                if (!processInfo) continue;
                applications.set(input.processId, {
                    id: makeApplicationId(processInfo.pid, processInfo.startTime),
                    name: input.applicationName || processInfo.name || `Application ${processInfo.pid}`,
                });
            }
            return [...applications.values()].sort((first, second) => first.name.localeCompare(second.name));
        },
        resolveWindow: async (sourceId: string): Promise<string | null> => {
            const windowId = parseX11WindowId(sourceId);
            if (windowId === null || !(await canResolveX11Windows(dependencies))) return null;

            try {
                const output = await dependencies.execute(
                    dependencies.xpropExecutable,
                    ["-id", `0x${windowId.toString(16)}`, "_NET_WM_PID"],
                    1000,
                );
                const pidMatch = output.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/);
                if (!pidMatch) return null;
                const pid = Number(pidMatch[1]);
                const processInfo = await dependencies.readProcessInfo(pid);
                if (!processInfo || processInfo.pid !== pid) return null;
                return makeApplicationId(pid, processInfo.startTime);
            } catch {
                return null;
            }
        },
        start: async (target, excludedProcessIds, callbacks, signal) => {
            if (!isValidTarget(target)) throw new Error("The selected Linux audio target is unknown.");
            if (signal?.aborted) throw abortError();
            await pulse.assertAvailable();
            if (signal?.aborted) throw abortError();
            const applicationTarget =
                target.kind === "application" ? await resolveApplicationTarget(target, dependencies) : null;
            if (signal?.aborted) throw abortError();
            const session = new LinuxShareAudioSession(
                dependencies,
                pulse,
                target,
                excludedProcessIds,
                callbacks,
                applicationTarget,
                signal,
            );
            await session.start();
            return { stop: () => session.stop() };
        },
    };
}

function createDefaultDependencies(): LinuxShareAudioDependencies {
    return {
        execute: executeFile,
        spawn: (executable, args) =>
            spawnChild(executable, [...args], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                env: createLinuxAudioCommandEnvironment(process.env),
            }),
        readProcessInfo: readLinuxProcessInfo,
        environment: process.env,
        xpropExecutable: "xprop",
        pactlExecutable: "pactl",
        parecExecutable: "parec",
    };
}

function executeFile(executable: string, args: readonly string[], timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            [...args],
            {
                encoding: "utf8",
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
                env: createLinuxAudioCommandEnvironment(process.env),
            },
            (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
            },
        );
    });
}

async function readLinuxProcessInfo(pid: number): Promise<LinuxAudioProcessInfo | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const openParen = stat.indexOf("(");
        const closeParen = stat.lastIndexOf(")");
        if (openParen < 0 || closeParen <= openParen) return null;
        const fields = stat
            .slice(closeParen + 1)
            .trim()
            .split(/\s+/);
        const parentPid = Number(fields[1]);
        const startTime = fields[19];
        if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !startTime) return null;
        return {
            pid,
            parentPid,
            startTime,
            name: stat.slice(openParen + 1, closeParen).slice(0, 128),
        };
    } catch {
        return null;
    }
}

async function canResolveX11Windows(dependencies: LinuxShareAudioDependencies): Promise<boolean> {
    if (!dependencies.environment.DISPLAY) return false;
    try {
        await dependencies.execute(dependencies.xpropExecutable, ["-root", "_NET_SUPPORTED"], 1000);
        return true;
    } catch {
        return false;
    }
}

async function resolveApplicationTarget(
    target: Extract<ShareAudioTarget, { kind: "application" }>,
    dependencies: LinuxShareAudioDependencies,
): Promise<{ pid: number; startTime: string }> {
    const parsed = parseApplicationId(target.id);
    if (!parsed) throw new Error("The selected Linux audio application is unknown.");
    const processInfo = await dependencies.readProcessInfo(parsed.pid);
    if (!processInfo || processInfo.startTime !== parsed.startTime) {
        throw new Error("The selected Linux audio application is no longer available.");
    }
    return parsed;
}

function makeApplicationId(pid: number, startTime: string): string {
    return `linux-process:${pid}:${startTime}`;
}

function parseApplicationId(id: string): { pid: number; startTime: string } | null {
    const match = /^linux-process:(\d+):(\d+)$/.exec(id);
    if (!match) return null;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startTime: match[2] };
}

function isValidTarget(target: unknown): target is ShareAudioTarget {
    if (typeof target !== "object" || target === null) return false;
    const candidate = target as { kind?: unknown; id?: unknown };
    return candidate.kind === "system" || (candidate.kind === "application" && typeof candidate.id === "string");
}

function parseX11WindowId(sourceId: string): number | null {
    const match = /^window:(\d+)(?::\d+)?$/.exec(sourceId);
    if (!match) return null;
    const windowId = Number(match[1]);
    return Number.isSafeInteger(windowId) && windowId > 0 && windowId <= 0xffff_ffff ? windowId : null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
    const error = new Error("Linux playback capture was cancelled.");
    error.name = "AbortError";
    return error;
}
