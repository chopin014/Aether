/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { levelDb, MicrophoneGate, type MicrophoneGateConfig, MIN_LEVEL_DB } from "./MicrophoneGate";

const SAMPLE_RATE = 48000;
const BLOCK = 480; // 10 ms

/** A block of a constant-amplitude square wave, whose loudness is exactly `db` dB below full scale. */
function block(db: number): Float32Array {
    return new Float32Array(BLOCK).fill(10 ** (db / 20));
}

/** Runs `ms` milliseconds of a constant level through the gate and returns the last output block. */
function run(gate: MicrophoneGate, db: number, ms: number): Float32Array {
    let output = new Float32Array(BLOCK);
    const input = block(db);
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
        output = new Float32Array(BLOCK);
        gate.processBlock(input, output);
    }
    return output;
}

function gateWith(config: Partial<MicrophoneGateConfig>): MicrophoneGate {
    const gate = new MicrophoneGate(SAMPLE_RATE);
    gate.configure({ volume: 1, threshold: -50, pushToTalk: false, ...config });
    return gate;
}

describe("levelDb", () => {
    it("measures silence as the quietest level", () => {
        expect(levelDb(new Float32Array(BLOCK))).toBe(MIN_LEVEL_DB);
        expect(levelDb(new Float32Array(0))).toBe(MIN_LEVEL_DB);
    });

    it("measures full scale as 0 dB and half amplitude as about -6 dB", () => {
        expect(levelDb(block(0))).toBeCloseTo(0, 5);
        expect(levelDb(new Float32Array(BLOCK).fill(0.5))).toBeCloseTo(-6.02, 1);
    });
});

describe("MicrophoneGate with a manual threshold", () => {
    it("stays closed below the threshold and passes nothing", () => {
        const gate = gateWith({ threshold: -40 });
        const output = run(gate, -60, 200);
        expect(gate.open).toBe(false);
        expect(Math.max(...output)).toBe(0);
    });

    it("opens as soon as the level reaches the threshold", () => {
        const gate = gateWith({ threshold: -40 });
        run(gate, -60, 100);
        run(gate, -30, 10);
        expect(gate.open).toBe(true);
        expect(gate.threshold).toBe(-40);
    });

    it("keeps passing sound briefly after it gets quiet, then closes", () => {
        const gate = gateWith({ threshold: -40 });
        run(gate, -30, 100);
        run(gate, -70, 200);
        expect(gate.open).toBe(true);
        run(gate, -70, 200);
        expect(gate.open).toBe(false);
    });

    it("passes everything at the lowest setting", () => {
        const gate = gateWith({ threshold: MIN_LEVEL_DB });
        run(gate, -95, 100);
        expect(gate.open).toBe(true);
        expect(gate.threshold).toBeNull();
    });

    it("never closes without a threshold", () => {
        const gate = gateWith({ threshold: null });
        run(gate, -99, 100);
        expect(gate.open).toBe(true);
    });

    it("applies the volume once the gate is open", () => {
        const gate = gateWith({ threshold: null, volume: 0.5 });
        const output = run(gate, -20, 100);
        expect(output[BLOCK - 1]).toBeCloseTo(10 ** (-20 / 20) * 0.5, 5);
    });

    it("clamps the volume to the range 0 to 1", () => {
        const gate = gateWith({ threshold: null, volume: 3 });
        const output = run(gate, -20, 100);
        expect(output[BLOCK - 1]).toBeCloseTo(10 ** (-20 / 20), 5);
    });

    it("fades instead of switching sound off abruptly", () => {
        const gate = gateWith({ threshold: -40 });
        run(gate, -30, 100);
        const firstClosedBlock = new Float32Array(BLOCK);
        gate.setPushToTalkActive(false);
        gate.configure({ volume: 1, threshold: -10, pushToTalk: false });
        run(gate, -30, 400);
        gate.processBlock(block(-30), firstClosedBlock);
        expect(firstClosedBlock[0]).toBeLessThanOrEqual(10 ** (-30 / 20));
    });
});

describe("MicrophoneGate with an automatic threshold", () => {
    it("treats steady background noise as silence", () => {
        const gate = gateWith({ threshold: "auto" });
        run(gate, -55, 2000);
        expect(gate.open).toBe(false);
        expect(gate.threshold).not.toBeNull();
        expect(gate.threshold!).toBeGreaterThan(-55);
    });

    it("opens for speech well above the noise", () => {
        const gate = gateWith({ threshold: "auto" });
        run(gate, -60, 2000);
        run(gate, -30, 20);
        expect(gate.open).toBe(true);
    });

    it("keeps the threshold within a sensible range", () => {
        const gate = gateWith({ threshold: "auto" });
        run(gate, -2, 20000);
        expect(gate.threshold!).toBeLessThanOrEqual(-30);
        run(gate, -100, 20000);
        expect(gate.threshold!).toBeGreaterThanOrEqual(-70);
    });
});

describe("MicrophoneGate with push to talk", () => {
    it("is closed until the key is down, however loud the room is", () => {
        const gate = gateWith({ pushToTalk: true, threshold: -90 });
        run(gate, -10, 100);
        expect(gate.open).toBe(false);
    });

    it("is open while the key is down, even when nobody speaks", () => {
        const gate = gateWith({ pushToTalk: true, threshold: -10 });
        gate.setPushToTalkActive(true);
        run(gate, -80, 50);
        expect(gate.open).toBe(true);
    });

    it("closes when the key is released", () => {
        const gate = gateWith({ pushToTalk: true });
        gate.setPushToTalkActive(true);
        run(gate, -20, 50);
        gate.setPushToTalkActive(false);
        run(gate, -20, 50);
        expect(gate.open).toBe(false);
    });

    it("ignores the key when push to talk is off", () => {
        const gate = gateWith({ pushToTalk: false, threshold: -40 });
        gate.setPushToTalkActive(true);
        run(gate, -80, 400);
        expect(gate.open).toBe(false);
    });
});

describe("immediate privacy controls", () => {
    it.each(["push to talk release", "shortcut mute", "zero input gain"])(
        "silences the first block after %s",
        (reason) => {
            const gate = gateWith({ threshold: null, pushToTalk: reason === "push to talk release" });
            gate.setPushToTalkActive(true);
            run(gate, -10, 100);
            if (reason === "push to talk release") gate.setPushToTalkActive(false);
            else if (reason === "shortcut mute") gate.setShortcutMuted(true);
            else gate.configure({ threshold: null, pushToTalk: false, volume: 0 });
            const output = run(gate, -10, 10);
            expect(gate.open).toBe(false);
            expect(output.every((sample) => sample === 0)).toBe(true);
        },
    );

    it("releasing hold-to-mute restores the underlying PTT state, not voice activation", () => {
        const gate = gateWith({ threshold: null, pushToTalk: true });
        gate.setShortcutMuted(true);
        gate.setPushToTalkActive(true);
        expect(run(gate, -10, 10).every((sample) => sample === 0)).toBe(true);
        gate.setPushToTalkActive(false);
        gate.setShortcutMuted(false);
        expect(run(gate, -10, 10).every((sample) => sample === 0)).toBe(true);
    });
});
