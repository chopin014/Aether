/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import MediaDeviceHandler from "../MediaDeviceHandler";

/** Owns outgoing ringing for one call, including cancellation during output selection. */
export class DesktopCallRingtone {
    private audio?: HTMLAudioElement;

    /** Starts once while waiting for pickup, and stops immediately on pickup, failure, or disposal. */
    public setRinging = (ringing: boolean): void => {
        if (!ringing) {
            const previous = this.audio;
            this.audio = undefined;
            previous?.pause();
        } else if (!this.audio) {
            void this.start();
        }
    };

    private start = async (): Promise<void> => {
        try {
            const audio = new Audio(new URL("../../res/media/ringback.mp3", import.meta.url).href);
            this.audio = audio;
            audio.loop = true;
            audio.volume = 0.5;
            const output = MediaDeviceHandler.getAudioOutput();
            if (output && audio.setSinkId) {
                try {
                    await audio.setSinkId(output);
                } catch (error) {
                    logger.debug("Could not route ringtone; using default output", error);
                }
            }
            if (this.audio !== audio) return;
            try {
                await audio.play();
            } catch (error) {
                if (this.audio === audio) this.audio = undefined;
                throw error;
            }
            if (this.audio !== audio) audio.pause();
        } catch (error) {
            logger.debug("Could not play outgoing ringtone", error);
        }
    };
}
