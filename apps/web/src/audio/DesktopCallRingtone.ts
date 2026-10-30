/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import MediaDeviceHandler from "../MediaDeviceHandler";

/** Owns one decoded, continuously looping ringback for a call. */
export class DesktopCallRingtone {
    private playback?: { context: AudioContext; abort: AbortController; source?: AudioBufferSourceNode };

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
            const response = await fetch(new URL("../../res/media/ringback.mp3", import.meta.url).href, {
                signal: playback.abort.signal,
            });
            if (!response.ok) throw new Error(`Could not load ringback: ${response.status}`);
            const buffer = await context.decodeAudioData(await response.arrayBuffer());
            if (this.playback !== playback) return;
            const gain = context.createGain();
            gain.gain.value = 0.5;
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
            logger.debug("Could not play outgoing ringback", error);
        }
    };
}
