/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { type ElementCallMediaSettings, type ElementCallHandle } from "@element-hq/element-call-component/api";

import SettingsStore from "../../settings/SettingsStore";
import MediaDeviceHandler from "../../MediaDeviceHandler";
import { type MicrophoneGateConfig } from "./MicrophoneGate";
import { MicrophoneProcessor } from "./MicrophoneProcessor";
import { PushToTalkController } from "./PushToTalk";
import { DesktopShortcutManager } from "./DesktopShortcutManager";
import { playDesktopVoiceSound } from "../DesktopVoiceSounds";

/** The settings the audio follows; a change to any of them is sent to the calls on screen. */
const WATCHED_SETTINGS = [
    "webrtc_audioinput",
    "webrtc_audiooutput",
    "webrtc_videoinput",
    "webrtc_audio_autoGainControl",
    "webrtc_audio_echoCancellation",
    "VideoView.flipVideoHorizontally",
    "desktopMicrophoneVolume",
    "desktopSpeakerVolume",
    "desktopInputProfile",
    "desktopNoiseSuppression",
    "desktopNoiseSuppressionStrength",
    "desktopVoiceDetection",
    "desktopInputSensitivityAuto",
    "desktopInputSensitivity",
    "desktopInputMode",
    "desktopPushToTalkKey",
    "desktopPushToTalkReleaseDelay",
] as const;

/** The gate settings the stored preferences ask for. Shared with the microphone test in the settings. */
export function getMicrophoneGateConfig(): MicrophoneGateConfig {
    const volume = SettingsStore.getValue("desktopMicrophoneVolume") / 100;
    const pushToTalk = SettingsStore.getValue("desktopInputMode") === "push_to_talk";
    switch (SettingsStore.getValue("desktopInputProfile")) {
        // Studio sends the microphone as it is, so it never gates.
        case "studio":
            return { volume, threshold: null, pushToTalk, noiseSuppression: null, voiceDetection: false };
        case "voice_isolation":
            return { volume, threshold: "auto", pushToTalk, noiseSuppression: 100, voiceDetection: true };
    }
    const enhanced = SettingsStore.getValue("desktopNoiseSuppression") === "enhanced";
    return {
        volume,
        threshold: SettingsStore.getValue("desktopInputSensitivityAuto")
            ? "auto"
            : SettingsStore.getValue("desktopInputSensitivity"),
        pushToTalk,
        noiseSuppression: enhanced ? SettingsStore.getValue("desktopNoiseSuppressionStrength") : null,
        voiceDetection: enhanced && SettingsStore.getValue("desktopVoiceDetection"),
    };
}

/**
 * Whether the browser should suppress noise itself. Only when asked for: under enhanced noise suppression it
 * would distort the speech the model then has to clean up.
 */
export function getBrowserNoiseSuppression(): boolean {
    return (
        SettingsStore.getValue("desktopInputProfile") === "custom" &&
        SettingsStore.getValue("desktopNoiseSuppression") === "standard"
    );
}

/**
 * Applies the voice and video settings to every Element Call on screen: the devices, echo cancellation,
 * automatic gain and the browser's noise suppression, mirroring your own video, the speaker volume, and a
 * microphone processor for noise suppression, the microphone volume, sensitivity and push to talk. Does nothing
 * unless the desktop shell is on.
 */
export class DesktopVoicePipeline {
    private static current?: DesktopVoicePipeline;

    /** The shared pipeline. Created on first use, because it keeps listening to settings once calls are shown. */
    public static get instance(): DesktopVoicePipeline {
        return (DesktopVoicePipeline.current ??= new DesktopVoicePipeline());
    }

    private readonly handles = new Set<ElementCallHandle>();
    private readonly processor = new MicrophoneProcessor(getMicrophoneGateConfig());
    private readonly pushToTalk = new PushToTalkController();
    private watchers: string[] = [];
    private stopListening?: () => void;
    private stopShortcuts?: () => void;

    /** The microphone processor, for the settings' microphone test to compare against. */
    public get microphoneProcessor(): MicrophoneProcessor {
        return this.processor;
    }

    /**
     * Applies the settings to a call's component and keeps doing so until it is detached. Called as soon as the
     * component exists, which is before the call joins, so the first call already uses the chosen devices.
     * @returns A function that stops following the settings for this component.
     */
    public attach(handle: ElementCallHandle): () => void {
        if (!SettingsStore.getValue("feature_desktop_shell")) return () => {};
        this.handles.add(handle);
        if (this.handles.size === 1) this.start();
        this.send([handle]);
        return () => {
            this.handles.delete(handle);
            if (this.handles.size === 0) this.stop();
        };
    }

    private start(): void {
        this.watchers = WATCHED_SETTINGS.map((name) => SettingsStore.watchSetting(name, null, this.onSettingChanged));
        this.stopListening = this.pushToTalk.onChange(this.onPushToTalkChanged);
        this.stopShortcuts = DesktopShortcutManager.instance.onEvent((event) => {
            if (event.id === "push_to_talk") {
                this.pushToTalk.setPressed(
                    event.pressed && SettingsStore.getValue("desktopInputMode") === "push_to_talk",
                    event.reset,
                );
            } else if (event.id === "push_to_mute") this.processor.setShortcutMuted(event.pressed);
        });
        // The session can receive a hold before a call's media component exists.
        this.processor.setShortcutMuted(DesktopShortcutManager.instance.isHeld("push_to_mute"));
        this.applyGate();
    }

    private stop(): void {
        for (const watcher of this.watchers) SettingsStore.unwatchSetting(watcher);
        this.watchers = [];
        this.stopListening?.();
        this.stopShortcuts?.();
        this.pushToTalk.setPressed(false, true);
        this.processor.setShortcutMuted(false);
        this.pushToTalk.stop();
        this.processor.setPushToTalkActive(false);
    }

    private readonly onSettingChanged = (): void => {
        this.applyGate();
        this.send([...this.handles]);
    };

    private applyGate(): void {
        const config = getMicrophoneGateConfig();
        this.processor.setConfig(config);
        this.pushToTalk.configure(
            SettingsStore.getValue("desktopPushToTalkKey"),
            SettingsStore.getValue("desktopPushToTalkReleaseDelay"),
        );
        this.pushToTalk.setPressed(false, true);
        if (!config.pushToTalk) {
            this.pushToTalk.stop();
            this.processor.setPushToTalkActive(false);
        }
    }

    private readonly onPushToTalkChanged = (active: boolean): void => {
        this.processor.setPushToTalkActive(active);
        // Talking while muted or deafened sends nothing, so it should not sound as if it did.
        if (SettingsStore.getValue("audioInputMuted") || SettingsStore.getValue("desktopDeafened")) return;
        void playDesktopVoiceSound(active ? "pttActivate" : "pttDeactivate");
    };

    private send(handles: ElementCallHandle[]): void {
        const settings: ElementCallMediaSettings = {
            audioInput: MediaDeviceHandler.getAudioInput(),
            audioOutput: MediaDeviceHandler.getAudioOutput(),
            videoInput: MediaDeviceHandler.getVideoInput(),
            autoGainControl: MediaDeviceHandler.getAudioAutoGainControl(),
            echoCancellation: MediaDeviceHandler.getAudioEchoCancellation(),
            noiseSuppression: getBrowserNoiseSuppression(),
            playbackVolume: SettingsStore.getValue("desktopSpeakerVolume") / 100,
            mirrorLocalVideo: SettingsStore.getValue("VideoView.flipVideoHorizontally"),
            microphoneProcessor: this.processor,
        };
        for (const handle of handles) {
            handle.configureMedia(settings).catch((error) => logger.warn("Could not apply the voice settings", error));
        }
    }
}
