/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { emptyCallConnectionStats, isCallConnectionStats } from "./CallConnectionStats";

describe("call connection statistics validation", () => {
    const connected = {
        ...emptyCallConnectionStats("connected"),
        quality: "good",
        rttMs: 17,
        averageRttMs: 17,
        outboundPacketLossPercent: 0,
        history: [17],
    };

    it("accepts measured reports and empty lifecycle states", () => {
        expect(isCallConnectionStats(connected)).toBe(true);
        expect(isCallConnectionStats(emptyCallConnectionStats("connecting"))).toBe(true);
        expect(isCallConnectionStats(emptyCallConnectionStats("reconnecting"))).toBe(true);
        expect(isCallConnectionStats(emptyCallConnectionStats("disconnected"))).toBe(true);
    });

    it.each([null, undefined, 0, "connected", {}, { ...connected, history: "17" }])(
        "rejects invalid data %j",
        (value) => {
            expect(isCallConnectionStats(value)).toBe(false);
        },
    );

    it.each([
        { state: "ready" },
        { quality: "excellent" },
        { rttMs: Number.NaN },
        { rttMs: Number.POSITIVE_INFINITY },
        { rttMs: -1 },
        { averageRttMs: undefined },
        { outboundPacketLossPercent: 101 },
        { outboundPacketLossPercent: -1 },
        { history: [17, "20"] },
        { history: [Number.NaN] },
        { history: Array(31).fill(17) },
        { state: "reconnecting" },
    ])("rejects invalid measurements %j", (invalid) => {
        expect(isCallConnectionStats({ ...connected, ...invalid })).toBe(false);
    });
});
