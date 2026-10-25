/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { LinuxShareAudioDependencies } from "./LinuxShareAudioDependencies.js";

interface PulseSinkInputJson {
    index?: unknown;
    sink?: unknown;
    properties?: unknown;
}

interface PulseSinkJson {
    index?: unknown;
    monitor_source?: unknown;
}

/** A PulseAudio playback stream that can be monitored without changing its routing. */
export interface LinuxPulseSinkInput {
    index: number;
    sinkIndex: number;
    processId: number | null;
    applicationName: string | null;
}

/** A playback output and its read-only monitor source. */
export interface LinuxPulseSink {
    index: number;
    monitorSource: string | null;
}

/**
 * Queries PulseAudio or PipeWire-Pulse through its JSON CLI interface. Native PipeWire and JACK streams that are not
 * exposed by PulseAudio are outside this provider's capture graph.
 */
export class LinuxPulseAudioClient {
    private readonly dependencies: LinuxShareAudioDependencies;

    public constructor(dependencies: LinuxShareAudioDependencies) {
        this.dependencies = dependencies;
    }

    /** Checks that the daemon and the required per-stream capture option are available. */
    public async assertAvailable(): Promise<void> {
        try {
            const info = await this.dependencies.execute(this.dependencies.pactlExecutable, ["info"], 3000);
            const versionMatch = info.match(/^Server Version:\s*(\d+)\.(\d+)\.(\d+)/m);
            if (!versionMatch) throw new Error("PulseAudio server version is unavailable.");
            const [major, minor, patch] = versionMatch.slice(1).map(Number);
            if (major === 0 && (minor < 9 || (minor === 9 && patch < 11))) {
                throw new Error("PulseAudio 0.9.11 or later is required for per-stream playback capture.");
            }

            const help = await this.dependencies.execute(this.dependencies.parecExecutable, ["--help"], 3000);
            if (!help.includes("--monitor-stream") || !help.includes("--latency-msec")) {
                throw new Error("parec does not support per-application playback capture.");
            }

            const [, sinks] = await Promise.all([this.listSinkInputs(), this.listSinks()]);
            if (sinks.length === 0 || sinks.some((sink) => !sink.monitorSource)) {
                throw new Error("PulseAudio does not expose playback monitor sources for every sink.");
            }
        } catch (error) {
            throw new Error(
                `Linux playback capture requires a reachable PulseAudio or PipeWire Pulse server: ${errorMessage(error)}`,
                {
                    cause: error,
                },
            );
        }
    }

    /** Lists current playback streams and their owning process IDs. */
    public async listSinkInputs(): Promise<LinuxPulseSinkInput[]> {
        const output = await this.dependencies.execute(
            this.dependencies.pactlExecutable,
            ["-f", "json", "list", "sink-inputs"],
            3000,
        );
        const parsed: unknown = JSON.parse(output);
        if (!Array.isArray(parsed)) throw new Error("pactl returned an invalid sink-input list.");

        const result: LinuxPulseSinkInput[] = [];
        for (const item of parsed as PulseSinkInputJson[]) {
            const index = nonNegativeInteger(item.index);
            const sinkIndex = nonNegativeInteger(item.sink);
            const properties = isStringRecord(item.properties) ? item.properties : {};
            if (index === null || sinkIndex === null) continue;

            result.push({
                index,
                sinkIndex,
                processId: positiveInteger(properties["application.process.id"]),
                applicationName: safeApplicationName(properties),
            });
        }
        return result;
    }

    /** Lists playback sinks and the monitor source associated with each sink. */
    public async listSinks(): Promise<LinuxPulseSink[]> {
        const output = await this.dependencies.execute(
            this.dependencies.pactlExecutable,
            ["-f", "json", "list", "sinks"],
            3000,
        );
        const parsed: unknown = JSON.parse(output);
        if (!Array.isArray(parsed)) throw new Error("pactl returned an invalid sink list.");

        const result: LinuxPulseSink[] = [];
        for (const item of parsed as PulseSinkJson[]) {
            const index = nonNegativeInteger(item.index);
            if (index === null) continue;
            result.push({
                index,
                monitorSource: typeof item.monitor_source === "string" ? item.monitor_source : null,
            });
        }
        return result;
    }
}

function positiveInteger(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return (
        typeof value === "object" && value !== null && Object.values(value).every((item) => typeof item === "string")
    );
}

function safeApplicationName(properties: Record<string, string>): string | null {
    const value = properties["application.name"]?.trim() || properties["application.process.binary"]?.trim();
    if (!value || value === "(null)") return null;
    return value.slice(0, 128);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
