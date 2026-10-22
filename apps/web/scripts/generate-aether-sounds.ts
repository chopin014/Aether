/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Original two-note cues. Keep these reproducible and independent of third-party sound packs.
const cues = {
    mute: [620, 390],
    unmute: [390, 620],
    deafen: [480, 240],
    undeafen: [240, 480],
    join: [520, 780],
    leave: [780, 520],
};
const directory = fileURLToPath(new URL("../res/media/aether/", import.meta.url));
mkdirSync(directory, { recursive: true });
const rate = 24000;
const noteDuration = 0.085;
const gap = 0.025;
const count = Math.ceil(rate * (noteDuration * 2 + gap));
for (const [name, notes] of Object.entries(cues)) {
    const wav = Buffer.alloc(44 + count * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(count * 2, 40);
    for (let sample = 0; sample < count; sample++) {
        const time = sample / rate;
        const note = time < noteDuration ? 0 : 1;
        const local = time - note * (noteDuration + gap);
        const envelope = local >= 0 && local < noteDuration ? Math.sin((Math.PI * local) / noteDuration) ** 2 : 0;
        const value = Math.sin(2 * Math.PI * notes[note] * local) * envelope * 0.55;
        wav.writeInt16LE(Math.round(value * 32767), 44 + sample * 2);
    }
    writeFileSync(`${directory}/${name}.wav`, wav);
}
