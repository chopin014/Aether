/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const temporary = mkdtempSync(path.join(tmpdir(), "aether-audio-"));
    try {
        for (const [target, source] of Object.entries(recordings)) {
            const looping = target === "ring" || target === "ringback";
            const loudness = target === "message" || target === "ring" ? -26 : -20;
            // Trim the silent tail without removing internal pauses. Looping music must not receive padding.
            const filter =
                "areverse,silenceremove=start_periods=1:start_duration=0.02:start_threshold=-60dB,areverse," +
                (looping ? "" : "apad=pad_dur=0.08,") +
                `loudnorm=I=${loudness}:TP=-2:LRA=7`;
            const prepared = path.join(temporary, "prepared.wav");
            const prepare = spawnSync(
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
                    prepared,
                ],
                { stdio: "inherit" },
            );
            if (prepare.error) throw prepare.error;
            if (prepare.status !== 0) throw new Error(`Could not prepare ${source}`);

            let outputFilter = "anull";
            if (looping) {
                const probe = spawnSync(
                    "ffprobe",
                    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", prepared],
                    { encoding: "utf8" },
                );
                if (probe.status !== 0) throw new Error(`Could not measure ${source}`);
                const duration = Number(probe.stdout.trim());
                const overlap = 0.12;
                if (!Number.isFinite(duration) || duration <= overlap * 2) throw new Error(`Invalid loop: ${source}`);
                // Put the end/start crossfade at the end of the file. Its last sample flows directly into
                // the first sample on repetition, preserving the music without an inserted silent gap.
                outputFilter =
                    `asplit=3[body][tail][head];` +
                    `[body]atrim=start=${overlap}:end=${duration - overlap},asetpts=PTS-STARTPTS[middle];` +
                    `[tail]atrim=start=${duration - overlap},asetpts=PTS-STARTPTS[end];` +
                    `[head]atrim=end=${overlap},asetpts=PTS-STARTPTS[start];` +
                    `[end][start]acrossfade=d=${overlap}:c1=tri:c2=tri[seam];` +
                    `[middle][seam]concat=n=2:v=0:a=1`;
            } else if (target.endsWith(".wav")) {
                const meter = spawnSync(
                    "ffmpeg",
                    [
                        "-v",
                        "error",
                        "-i",
                        prepared,
                        "-af",
                        "ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=-",
                        "-f",
                        "null",
                        "-",
                    ],
                    { encoding: "utf8" },
                );
                if (meter.status !== 0) throw new Error(`Could not measure ${source}`);
                const peaks = [...meter.stdout.matchAll(/lavfi\.r128\.M=(-?[\d.]+)/g)].map((match) => Number(match[1]));
                const momentary = Math.max(...peaks);
                if (!Number.isFinite(momentary)) throw new Error(`Invalid loudness: ${source}`);
                // Short cues need matched momentary loudness as well as integrated loudness: a long,
                // quiet tail must not make the attack louder than the paired control's attack.
                outputFilter = `volume=${-18 - momentary}dB`;
            }
            for (const extension of target.endsWith(".wav") ? [""] : [".mp3", ".ogg"]) {
                const result = spawnSync(
                    "ffmpeg",
                    [
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-y",
                        "-i",
                        prepared,
                        "-map_metadata",
                        "-1",
                        "-af",
                        outputFilter,
                        "-ar",
                        "48000",
                        "-ac",
                        "2",
                        path.resolve(mediaDirectory, target + extension),
                    ],
                    { stdio: "inherit" },
                );
                if (result.error) throw result.error;
                if (result.status !== 0) throw new Error(`Could not encode ${source}`);
            }
        }
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}
