/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import MediaDeviceHandler from "../MediaDeviceHandler";
import { _td } from "../languageHandler";

/**
 * Every cue Aether can play, in the order the settings list them. The first group has been there since the
 * voice controls were added; the second group is shown behind "Show more sounds".
 * Control cues use the custom Aether recordings; participant and push-to-talk cues are synthesized.
 */
export const DESKTOP_VOICE_SOUNDS = [
    { id: "mute", label: _td("desktop|voice_settings|sound_mute"), extra: false },
    { id: "unmute", label: _td("desktop|voice_settings|sound_unmute"), extra: false },
    { id: "deafen", label: _td("desktop|voice_settings|sound_deafen"), extra: false },
    { id: "undeafen", label: _td("desktop|voice_settings|sound_undeafen"), extra: false },
    { id: "join", label: _td("desktop|voice_settings|sound_join"), extra: false },
    { id: "leave", label: _td("desktop|voice_settings|sound_leave"), extra: false },
    { id: "userJoined", label: _td("desktop|voice_settings|sound_user_joined"), extra: true },
    { id: "userLeft", label: _td("desktop|voice_settings|sound_user_left"), extra: true },
    { id: "cameraOn", label: _td("desktop|voice_settings|sound_camera_on"), extra: true },
    { id: "cameraOff", label: _td("desktop|voice_settings|sound_camera_off"), extra: true },
    { id: "screenShareStart", label: _td("desktop|voice_settings|sound_screen_share_start"), extra: true },
    { id: "screenShareStop", label: _td("desktop|voice_settings|sound_screen_share_stop"), extra: true },
    { id: "pttActivate", label: _td("desktop|voice_settings|sound_ptt_activate"), extra: true },
    { id: "pttDeactivate", label: _td("desktop|voice_settings|sound_ptt_deactivate"), extra: true },
] as const;

/** The name of a cue, as used in settings and by the callers that play it. */
export type DesktopVoiceSound = (typeof DESKTOP_VOICE_SOUNDS)[number]["id"];

const sounds: Record<DesktopVoiceSound, string> = {
    mute: new URL("../../res/media/aether/mute.wav", import.meta.url).href,
    unmute: new URL("../../res/media/aether/unmute.wav", import.meta.url).href,
    deafen: new URL("../../res/media/aether/deafen.wav", import.meta.url).href,
    undeafen: new URL("../../res/media/aether/undeafen.wav", import.meta.url).href,
    join: new URL("../../res/media/aether/join.wav", import.meta.url).href,
    leave: new URL("../../res/media/aether/leave.wav", import.meta.url).href,
    userJoined: new URL("../../res/media/aether/user-joined.wav", import.meta.url).href,
    userLeft: new URL("../../res/media/aether/user-left.wav", import.meta.url).href,
    cameraOn: new URL("../../res/media/aether/camera-on.wav", import.meta.url).href,
    cameraOff: new URL("../../res/media/aether/camera-off.wav", import.meta.url).href,
    screenShareStart: new URL("../../res/media/aether/screen-share-start.wav", import.meta.url).href,
    screenShareStop: new URL("../../res/media/aether/screen-share-stop.wav", import.meta.url).href,
    pttActivate: new URL("../../res/media/aether/ptt-activate.wav", import.meta.url).href,
    pttDeactivate: new URL("../../res/media/aether/ptt-deactivate.wav", import.meta.url).href,
};

/**
 * The cues the user has switched off. Before per-cue settings there was one switch for all of them
 * (`desktopVoiceSounds`); until the user changes a cue, an "off" there still turns every cue off.
 */
export function getDesktopVoiceSoundToggles(): Record<string, boolean> {
    const stored = SettingsStore.getValueAt(SettingLevel.DEVICE, "desktopVoiceSoundToggles", null, true);
    if (stored) return stored;
    const legacy = SettingsStore.getValueAt(SettingLevel.DEVICE, "desktopVoiceSounds", null, true);
    if (legacy !== false) return {};
    return Object.fromEntries(DESKTOP_VOICE_SOUNDS.map(({ id }) => [id, false]));
}

/** Whether a cue is switched on. Cues the user has not touched are on. */
export function isDesktopVoiceSoundEnabled(sound: DesktopVoiceSound): boolean {
    return getDesktopVoiceSoundToggles()[sound] !== false;
}

/** Switches cues on or off, keeping the choices already made for the others. */
export async function setDesktopVoiceSoundEnabled(
    sound: DesktopVoiceSound | DesktopVoiceSound[],
    enabled: boolean,
): Promise<void> {
    const changed = Object.fromEntries([sound].flat().map((id) => [id, enabled]));
    const toggles = { ...getDesktopVoiceSoundToggles(), ...changed };
    await SettingsStore.setValue("desktopVoiceSoundToggles", null, SettingLevel.DEVICE, toggles);
}

let activeCue: { sound: DesktopVoiceSound; audio: HTMLAudioElement } | undefined;

/** Stops current and pending feedback, for example when the account is disposed. */
export function stopDesktopVoiceSound(): void {
    const previous = activeCue;
    activeCue = undefined;
    previous?.audio.pause();
}

/**
 * Plays the latest state through the selected output. Repeated events share one cue; a newer state
 * interrupts old feedback instead of building a queue. Previews respect the same playback ownership.
 */
export async function playDesktopVoiceSound(sound: DesktopVoiceSound, { preview = false } = {}): Promise<void> {
    if (!preview && !isDesktopVoiceSoundEnabled(sound)) return;
    if (!preview && activeCue?.sound === sound) return;
    // Conversation activity must not cut off feedback for the user’s own controls.
    const ambient = (id: DesktopVoiceSound): boolean => id === "userJoined" || id === "userLeft";
    if (!preview && ambient(sound) && activeCue && !ambient(activeCue.sound)) return;
    stopDesktopVoiceSound();
    const started = performance.now();
    try {
        const audio = new Audio(sounds[sound]);
        const cue = { sound, audio };
        activeCue = cue;
        audio.volume = 0.5;
        const release = (): void => {
            if (activeCue === cue) activeCue = undefined;
        };
        audio.onended = release;
        audio.onerror = release;
        const output = MediaDeviceHandler.getAudioOutput();
        if (output && audio.setSinkId) {
            try {
                await audio.setSinkId(output);
            } catch (error) {
                logger.debug("Could not route desktop voice cue; using default output", error);
            }
        }
        // Device selection can resolve after another action, or long after the state it describes.
        if (activeCue !== cue || performance.now() - started > 1000) {
            release();
            return;
        }
        try {
            await audio.play();
        } catch (error) {
            release();
            throw error;
        }
        if (activeCue !== cue) audio.pause();
    } catch (error) {
        logger.debug("Could not play desktop voice cue", error);
    }
}
