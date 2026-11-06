/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import MediaDeviceHandler from "../MediaDeviceHandler";

/** The looping call sounds: the ringback a caller hears, and the ring for an incoming call. */
export type DesktopCallRingtoneSound = "ringback" | "ring";

// Each URL is a literal so the bundler can find and emit the file.
const SOUNDS: Record<DesktopCallRingtoneSound, { url: () => string; gain: number }> = {
    ringback: { url: () => new URL("../../res/media/ringback.mp3", import.meta.url).href, gain: 0.5 },
    // An incoming call has to be heard over whatever else is playing, so it rings louder than the ringback.
    ring: { url: () => new URL("../../res/media/ring.mp3", import.meta.url).href, gain: 0.8 },
};

/** Owns one decoded, continuously looping call sound, played on the selected output device. */
export class DesktopCallRingtone {
    private playback?: { context: AudioContext; abort: AbortController; source?: AudioBufferSourceNode };

    /**
     * @param sound Which call sound to loop; the ringback by default.
     */
    public constructor(private readonly sound: DesktopCallRingtoneSound = "ringback") {}

    /** Starts once while waiting for pickup; cancels loading and playback on pickup, failure, or disposal. */
    public setRinging = (ringing: boolean): void => {
        if (!ringing) {
            const previous = this.playback;
            this.playback = undefined;
            previous?.abort.abort();
            previous?.source?.stop();
            void previous?.context.close().catch((error) => logger.debug("Could not close ringback output", error));
        } else if (!this.playback) {
            void this.start();
        }
    };

    private start = async (): Promise<void> => {
        let playback: NonNullable<DesktopCallRingtone["playback"]> | undefined;
        try {
            // Output routing is optional in browsers and is not yet declared by our DOM types.
            const context = new AudioContext({ latencyHint: "playback" }) as AudioContext & {
                setSinkId?: (deviceId: string) => Promise<void>;
            };
            playback = { context, abort: new AbortController() };
            this.playback = playback;
            await context.resume();
            const output = MediaDeviceHandler.getAudioOutput();
            if (output && context.setSinkId) {
                try {
                    await context.setSinkId(output);
                } catch (error) {
                    logger.debug("Could not route ringback; using default output", error);
                }
            }
            if (this.playback !== playback) return;
            const response = await fetch(SOUNDS[this.sound].url(), { signal: playback.abort.signal });
            if (!response.ok) throw new Error(`Could not load ${this.sound}: ${response.status}`);
            const buffer = await context.decodeAudioData(await response.arrayBuffer());
            if (this.playback !== playback) return;
            const gain = context.createGain();
            gain.gain.value = SOUNDS[this.sound].gain;
            gain.connect(context.destination);
            const source = context.createBufferSource();
            source.buffer = buffer;
            // Buffer looping does not seek or rebuffer an HTML media element at each repetition.
            source.loop = true;
            source.connect(gain);
            playback.source = source;
            source.start();
        } catch (error) {
            if (playback && this.playback !== playback) return;
            this.setRinging(false);
            logger.debug(`Could not play ${this.sound}`, error);
        }
    };
}
