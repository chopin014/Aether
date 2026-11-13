/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";

/** How one person is played in calls on this device. Anything left out is at its default. */
export interface VoiceUserPreference {
    /** Playback volume, from 0 to {@link MAX_USER_VOLUME}; 1 is the level they are received at. */
    volume?: number;
    /** Whether their microphone is muted for this user only. */
    muted?: boolean;
    /** Whether their soundboard sounds are muted for this user only. */
    soundboardMuted?: boolean;
    /** Whether their camera is hidden for this user only. */
    videoDisabled?: boolean;
}

/** The loudest a person can be played: twice the level they are received at. */
export const MAX_USER_VOLUME = 2;

/** A person's preference with every field filled in. */
export type ResolvedVoiceUserPreference = Required<VoiceUserPreference>;

const DEFAULTS: ResolvedVoiceUserPreference = { volume: 1, muted: false, soundboardMuted: false, videoDisabled: false };

export enum VoiceUserPreferencesEvent {
    /** Some person's preference changed. */
    Changed = "changed",
}

type EventHandlerMap = { [VoiceUserPreferencesEvent.Changed]: () => void };

/** Clamps a volume to what playback supports, treating anything unreadable as the default. */
export function clampUserVolume(volume: number): number {
    return Number.isFinite(volume) ? Math.max(0, Math.min(MAX_USER_VOLUME, volume)) : 1;
}

/**
 * Per-person call playback on this device, as Discord keeps it: a volume up to 200%, and mutes of their voice,
 * soundboard and camera that only this user hears or sees. Kept in a device setting, so it applies to every call.
 */
export class VoiceUserPreferences extends TypedEventEmitter<VoiceUserPreferencesEvent, EventHandlerMap> {
    private static internalInstance?: VoiceUserPreferences;

    public static get instance(): VoiceUserPreferences {
        if (!VoiceUserPreferences.internalInstance) {
            VoiceUserPreferences.internalInstance = new VoiceUserPreferences();
        }
        return VoiceUserPreferences.internalInstance;
    }

    private constructor() {
        super();
        this.setMaxListeners(100); // One for each room in the room list
        SettingsStore.watchSetting("desktopVoiceUserPreferences", null, () =>
            this.emit(VoiceUserPreferencesEvent.Changed),
        );
    }

    /** The person's preference, with defaults for anything they have not changed. */
    public get(userId: string): ResolvedVoiceUserPreference {
        const stored = SettingsStore.getValue("desktopVoiceUserPreferences")?.[userId];
        return {
            volume: clampUserVolume(stored?.volume ?? DEFAULTS.volume),
            muted: stored?.muted ?? DEFAULTS.muted,
            soundboardMuted: stored?.soundboardMuted ?? DEFAULTS.soundboardMuted,
            videoDisabled: stored?.videoDisabled ?? DEFAULTS.videoDisabled,
        };
    }

    /** Changes part of a person's preference. A preference back at every default is forgotten. */
    public async update(userId: string, change: VoiceUserPreference): Promise<void> {
        const all = { ...SettingsStore.getValue("desktopVoiceUserPreferences") };
        const next: ResolvedVoiceUserPreference = { ...this.get(userId), ...change };
        next.volume = clampUserVolume(next.volume);
        const stored: VoiceUserPreference = {};
        for (const key of Object.keys(DEFAULTS) as (keyof ResolvedVoiceUserPreference)[]) {
            if (next[key] !== DEFAULTS[key]) Object.assign(stored, { [key]: next[key] });
        }
        if (Object.keys(stored).length > 0) all[userId] = stored;
        else delete all[userId];
        await SettingsStore.setValue("desktopVoiceUserPreferences", null, SettingLevel.DEVICE, all);
    }

    /** Sets a person's volume. Moving the slider also unmutes them, as in Discord. */
    public setVolume(userId: string, volume: number): Promise<void> {
        const clamped = clampUserVolume(volume);
        return this.update(userId, clamped > 0 ? { volume: clamped, muted: false } : { volume: clamped });
    }

    /** Mutes or unmutes a person's voice for this user only. */
    public toggleMuted(userId: string): Promise<void> {
        return this.update(userId, { muted: !this.get(userId).muted });
    }

    /** The volume a person is actually played at: nothing while muted. */
    public effectiveVolume(userId: string): number {
        const preference = this.get(userId);
        return preference.muted ? 0 : preference.volume;
    }
}
