/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Measurements of this device's media connection to the call server, rather than mouth-to-ear latency. */
export interface CallConnectionStats {
    /** The media transport state, independently of Matrix room membership. */
    readonly state: "connecting" | "connected" | "reconnecting" | "disconnected";
    /** Combines measured latency and sent audio loss with LiveKit's local connection quality. */
    readonly quality: "unknown" | "good" | "poor" | "bad" | "lost";
    /** The latest measured media round trip, in milliseconds, or null until available. */
    readonly rttMs: number | null;
    /** Mean of the available measurements in history, or null until available. */
    readonly averageRttMs: number | null;
    /** Percentage of outgoing audio packets reported lost by the server, or null until available. */
    readonly outboundPacketLossPercent: number | null;
    /** The last thirty one-second media round trips; null represents an unavailable measurement. */
    readonly history: readonly (number | null)[];
}

/** Creates an empty measurement when joining, reconnecting or leaving a media transport. */
export function emptyCallConnectionStats(state: CallConnectionStats["state"]): CallConnectionStats {
    return {
        state,
        quality: "unknown",
        rttMs: null,
        averageRttMs: null,
        outboundPacketLossPercent: null,
        history: [],
    };
}

/** Checks untrusted bridge data before exposing it to the desktop call controls. */
export function isCallConnectionStats(value: unknown): value is CallConnectionStats {
    if (!value || typeof value !== "object") return false;
    const report = value as Partial<CallConnectionStats>;
    const measurement = (n: unknown): boolean => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
    return (
        ["connecting", "connected", "reconnecting", "disconnected"].includes(report.state ?? "") &&
        ["unknown", "good", "poor", "bad", "lost"].includes(report.quality ?? "") &&
        measurement(report.rttMs) &&
        measurement(report.averageRttMs) &&
        measurement(report.outboundPacketLossPercent) &&
        (report.outboundPacketLossPercent === null ||
            (typeof report.outboundPacketLossPercent === "number" && report.outboundPacketLossPercent <= 100)) &&
        Array.isArray(report.history) &&
        report.history.length <= 30 &&
        report.history.every(measurement) &&
        (report.state === "connected" ||
            (report.quality === "unknown" &&
                report.rttMs === null &&
                report.averageRttMs === null &&
                report.outboundPacketLossPercent === null &&
                report.history.length === 0))
    );
}
