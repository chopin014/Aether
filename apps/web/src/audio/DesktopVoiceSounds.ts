/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import SettingsStore from "../settings/SettingsStore";
import MediaDeviceHandler from "../MediaDeviceHandler";

const sounds = {
    mute: new URL("../../res/media/aether/mute.wav", import.meta.url).href,
    unmute: new URL("../../res/media/aether/unmute.wav", import.meta.url).href,
    deafen: new URL("../../res/media/aether/deafen.wav", import.meta.url).href,
    undeafen: new URL("../../res/media/aether/undeafen.wav", import.meta.url).href,
    join: new URL("../../res/media/aether/join.wav", import.meta.url).href,
    leave: new URL("../../res/media/aether/leave.wav", import.meta.url).href,
};

/** Play an original Aether control cue through the selected output device. Never interrupt a call on failure. */
export async function playDesktopVoiceSound(sound: keyof typeof sounds): Promise<void> {
    if (!SettingsStore.getValue("desktopVoiceSounds")) return;
    try {
        const audio = new Audio(sounds[sound]);
        audio.volume = 0.35;
        const output = MediaDeviceHandler.getAudioOutput();
        if (output && audio.setSinkId) await audio.setSinkId(output);
        await audio.play();
    } catch (error) {
        logger.debug("Could not play desktop voice cue", error);
    }
}
