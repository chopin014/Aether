/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Only cues without a supplied recording are synthesized. Never overwrite the custom control recordings.
const cues: Record<string, number[]> = {
    "user-joined": [450, 675],
    "user-left": [675, 450],
    "ptt-activate": [880],
    "ptt-deactivate": [660],
};
const directory = fileURLToPath(new URL("../res/media/aether/", import.meta.url));
mkdirSync(directory, { recursive: true });
const rate = 24000;
const noteDuration = 0.085;
const gap = 0.025;
for (const [name, notes] of Object.entries(cues)) {
    const count = Math.ceil(rate * (noteDuration * notes.length + gap * (notes.length - 1)));
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
        const note = Math.min(notes.length - 1, Math.floor(time / (noteDuration + gap)));
        const local = time - note * (noteDuration + gap);
        const envelope = local >= 0 && local < noteDuration ? Math.sin((Math.PI * local) / noteDuration) ** 2 : 0;
        const value = Math.sin(2 * Math.PI * notes[note] * local) * envelope * 0.55;
        wav.writeInt16LE(Math.round(value * 32767), 44 + sample * 2);
    }
    writeFileSync(`${directory}/${name}.wav`, wav);
}

// Run with the directory of the original Aether recordings as the first argument. Originals stay outside the repo.
const sourceDirectory = process.argv[2];
if (sourceDirectory) {
    const recordings: Record<string, string> = {
        "aether/mute.wav": "v2 cosmic aether mute song.mp3",
        "aether/unmute.wav": "v2 cosmic aether unmute song.mp3",
        "aether/deafen.wav": "aether deafen song.mp3",
        "aether/undeafen.wav": "aether undeafen song.mp3",
        "aether/join.wav": "join call sound.mp3",
        "aether/leave.wav": "leaving call sound.mp3",
        "aether/camera-on.wav": "abrindo camera.mp3",
        "aether/camera-off.wav": "fechando camera.mp3",
        "aether/screen-share-start.wav": "transmitindo tela sound.mp3",
        "aether/screen-share-stop.wav": "destransmitindo tela sound.mp3",
        "message": "notifi.mp3",
        "ring": "musica recebendo ligacao.mp3",
        "ringback": "aether ligando 1.mp3",
    };
    const mediaDirectory = fileURLToPath(new URL("../res/media/", import.meta.url));
    for (const [target, source] of Object.entries(recordings)) {
        // Trim only the silent tail, leaving internal pauses and the recording's attack intact.
        // Keep a short fade to avoid clicks at the end and use a consistent, restrained loudness.
        const loudness = target === "message" || target === "ring" ? -26 : -20;
        const filter =
            "areverse,silenceremove=start_periods=1:start_duration=0.02:start_threshold=-60dB," +
            `areverse,apad=pad_dur=0.08,loudnorm=I=${loudness}:TP=-2:LRA=7,areverse,afade=t=in:d=0.015,areverse`;
        for (const extension of target.endsWith(".wav") ? [""] : [".mp3", ".ogg"]) {
            const result = spawnSync(
                "ffmpeg",
                [
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    path.resolve(sourceDirectory, source),
                    "-map_metadata",
                    "-1",
                    "-af",
                    filter,
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    path.resolve(mediaDirectory, target + extension),
                ],
                { stdio: "inherit" },
            );
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(`Could not prepare ${source}`);
        }
    }
}
