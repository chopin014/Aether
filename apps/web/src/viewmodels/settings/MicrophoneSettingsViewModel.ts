/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type MicrophoneSettingsViewSnapshot,
    type MicrophoneSettingsViewModel as MicrophoneSettingsViewModelInterface,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";

import { NoiseSuppressionProcessor } from "../../audio/NoiseSuppressionProcessor";
import MediaDeviceHandler, { MediaDeviceKindEnum } from "../../MediaDeviceHandler";
import SettingsStore from "../../settings/SettingsStore";
import { type SettingKey, type Settings } from "../../settings/Settings";
import { SettingLevel } from "../../settings/SettingLevel";
import { _t } from "../../languageHandler";

const clamp = (value: number, min: number, max: number, fallback: number): number =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Owns local microphone preview and device preferences. Preview audio never enters a call. */
export class MicrophoneSettingsViewModel
    extends BaseViewModel<MicrophoneSettingsViewSnapshot, undefined>
    implements MicrophoneSettingsViewModelInterface
{
    private stream?: MediaStream;
    private processor?: NoiseSuppressionProcessor;
    private playback?: HTMLAudioElement;
    private testGeneration = 0;
    private deviceGeneration = 0;

    public constructor() {
        super(undefined, {
            microphones: [],
            speakers: [],
            microphoneId: MediaDeviceHandler.getAudioInput() || "default",
            speakerId: MediaDeviceHandler.getAudioOutput() || "default",
            inputVolume: clamp(SettingsStore.getValue("webrtc_audio_inputVolume"), 0, 200, 100),
            testVolume: clamp(SettingsStore.getValue("webrtc_audio_microphoneTestVolume"), 0, 100, 50),
            automaticSensitivity: SettingsStore.getValue("webrtc_audio_automaticSensitivity") ?? true,
            sensitivityDb: clamp(SettingsStore.getValue("webrtc_audio_sensitivity"), -100, 0, -50),
            levelDb: -100,
            effectiveThresholdDb: SettingsStore.getValue("webrtc_audio_automaticSensitivity")
                ? -50
                : clamp(SettingsStore.getValue("webrtc_audio_sensitivity"), -100, 0, -50),
            voiceDetected: false,
            testing: false,
            starting: false,
            error: null,
            canSelectOutput: typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
        });
        this.disposables.track(this.stopTest);
        for (const setting of [
            "webrtc_audio_inputVolume",
            "webrtc_audio_microphoneTestVolume",
            "webrtc_audio_automaticSensitivity",
            "webrtc_audio_sensitivity",
        ] as const) {
            const watcher = SettingsStore.watchSetting(setting, null, this.syncPreferences);
            this.disposables.track(() => SettingsStore.unwatchSetting(watcher));
        }
        for (const setting of [
            "webrtc_audio_echoCancellation",
            "webrtc_audio_noiseSuppression",
            "webrtc_audio_autoGainControl",
        ] as const) {
            const watcher = SettingsStore.watchSetting(setting, null, this.restartTest);
            this.disposables.track(() => SettingsStore.unwatchSetting(watcher));
        }
        const devices = navigator.mediaDevices;
        devices?.addEventListener("devicechange", this.refreshDevices);
        this.disposables.track(() => devices?.removeEventListener("devicechange", this.refreshDevices));
        window.addEventListener("pagehide", this.stopTest);
        this.disposables.track(() => window.removeEventListener("pagehide", this.stopTest));
        void this.refreshDevices();
    }

    /** Start or stop a local test, including cancellation while permission is pending. */
    public toggleTest = (): void => {
        if (this.getSnapshot().testing || this.getSnapshot().starting) this.stopTest();
        else void this.startTest();
    };

    /** Change the actual microphone preference and restart an active preview with that device. */
    public setMicrophone = (microphoneId: string): void => {
        const restart = this.getSnapshot().testing || this.getSnapshot().starting;
        this.stopTest();
        const generation = this.testGeneration;
        this.snapshot.merge({ microphoneId, error: null });
        void MediaDeviceHandler.instance
            .setDevice(microphoneId, MediaDeviceKindEnum.AudioInput)
            .then(() => {
                if (this.isDisposed || generation !== this.testGeneration) return;
                if (restart) void this.startTest();
            })
            .catch((error: unknown) => {
                if (generation === this.testGeneration) this.fail(error);
            });
    };

    /** Route preview playback through the chosen output, and save the normal output preference. */
    public setSpeaker = (speakerId: string): void => {
        this.snapshot.merge({ speakerId, error: null });
        void MediaDeviceHandler.instance
            .setDevice(speakerId, MediaDeviceKindEnum.AudioOutput)
            .catch((error: unknown) => {
                if (this.getSnapshot().speakerId === speakerId) this.fail(error);
            });
        const playback = this.playback;
        if (playback && typeof playback.setSinkId === "function") {
            void playback.setSinkId(speakerId).catch((error: unknown) => {
                if (this.playback !== playback || this.getSnapshot().speakerId !== speakerId) return;
                this.stopTest();
                this.fail(error);
            });
        }
    };

    /** Adjust input gain for both calls and microphone preview. */
    public setInputVolume = (inputVolume: number): void => {
        inputVolume = clamp(inputVolume, 0, 200, 100);
        this.snapshot.merge({ inputVolume });
        this.save("webrtc_audio_inputVolume", inputVolume);
    };

    /** Set only the local test playback volume; call speaker volume is independent. */
    public setTestVolume = (testVolume: number): void => {
        testVolume = clamp(testVolume, 0, 100, 50);
        this.snapshot.merge({ testVolume });
        if (this.playback) this.playback.volume = testVolume / 100;
        this.save("webrtc_audio_microphoneTestVolume", testVolume);
    };

    /** Choose adaptive voice detection or the user's manual threshold. */
    public setAutomaticSensitivity = (automaticSensitivity: boolean): void => {
        this.snapshot.merge({
            automaticSensitivity,
            ...(!automaticSensitivity ? { effectiveThresholdDb: this.getSnapshot().sensitivityDb } : {}),
        });
        this.save("webrtc_audio_automaticSensitivity", automaticSensitivity);
    };

    /** Set the minimum input level that opens the microphone in manual mode. */
    public setSensitivityDb = (sensitivityDb: number): void => {
        sensitivityDb = clamp(sensitivityDb, -100, 0, -50);
        this.snapshot.merge({
            sensitivityDb,
            ...(!this.getSnapshot().automaticSensitivity ? { effectiveThresholdDb: sensitivityDb } : {}),
        });
        this.save("webrtc_audio_sensitivity", sensitivityDb);
    };

    private save<S extends SettingKey>(setting: S, value: Settings[S]["default"]): void {
        void SettingsStore.setValue(setting, null, SettingLevel.DEVICE, value).catch(this.fail);
    }

    private syncPreferences = (): void => {
        if (this.isDisposed) return;
        const testVolume = clamp(SettingsStore.getValue("webrtc_audio_microphoneTestVolume"), 0, 100, 50);
        const automaticSensitivity = SettingsStore.getValue("webrtc_audio_automaticSensitivity") ?? true;
        const sensitivityDb = clamp(SettingsStore.getValue("webrtc_audio_sensitivity"), -100, 0, -50);
        this.snapshot.merge({
            inputVolume: clamp(SettingsStore.getValue("webrtc_audio_inputVolume"), 0, 200, 100),
            testVolume,
            automaticSensitivity,
            sensitivityDb,
            ...(!automaticSensitivity ? { effectiveThresholdDb: sensitivityDb } : {}),
        });
        if (this.playback) this.playback.volume = testVolume / 100;
    };

    private restartTest = (): void => {
        if (this.isDisposed || (!this.getSnapshot().testing && !this.getSnapshot().starting)) return;
        this.stopTest();
        void this.startTest();
    };

    private refreshDevices = async (): Promise<void> => {
        const generation = ++this.deviceGeneration;
        try {
            const devices = await navigator.mediaDevices?.enumerateDevices();
            if (this.isDisposed || generation !== this.deviceGeneration || !devices) return;
            const choices = (kind: MediaDeviceKind): { id: string; label: string }[] => {
                const result = devices
                    .filter((device) => device.kind === kind)
                    .map((device, index) => ({
                        id: device.deviceId,
                        label:
                            device.label ||
                            (kind === "audioinput"
                                ? _t("settings|voip|microphone_device", { index: index + 1 })
                                : _t("settings|voip|speaker_device", { index: index + 1 })),
                    }));
                if (!result.some(({ id }) => id === "default")) {
                    result.unshift({ id: "default", label: _t("settings|voip|system_default_device") });
                }
                return result;
            };
            this.snapshot.merge({ microphones: choices("audioinput"), speakers: choices("audiooutput") });
        } catch (error) {
            // Device labels may be unavailable before permission. Starting a test still requests access.
            logger.warn("Could not enumerate microphone test devices", error);
        }
    };

    private startTest = async (): Promise<void> => {
        if (this.isDisposed) return;
        const generation = ++this.testGeneration;
        this.snapshot.merge({ starting: true, error: null });
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable");
            const { microphoneId } = this.getSnapshot();
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: microphoneId === "default" ? undefined : { exact: microphoneId },
                    echoCancellation: MediaDeviceHandler.getAudioEchoCancellation(),
                    noiseSuppression: MediaDeviceHandler.getAudioNoiseSuppression(),
                    autoGainControl: MediaDeviceHandler.getAudioAutoGainControl(),
                },
                video: false,
            });
            if (this.isDisposed || generation !== this.testGeneration) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            this.stream = stream;
            for (const track of stream.getAudioTracks()) {
                track.onended = (): void => {
                    if (generation === this.testGeneration) this.onMicrophoneEnded();
                };
            }
            const processor = (this.processor = new NoiseSuppressionProcessor((levelDb, voiceDetected, thresholdDb) => {
                if (this.isDisposed || generation !== this.testGeneration) return;
                this.snapshot.merge({
                    levelDb: Math.round(clamp(levelDb, -100, 0, -100)),
                    voiceDetected,
                    effectiveThresholdDb: Math.round(clamp(thresholdDb, -100, 0, -50)),
                });
            }));
            await processor.init({ track: stream.getAudioTracks()[0] });
            if (this.isDisposed || generation !== this.testGeneration) return;
            if (!processor.processedTrack) throw new Error("Microphone processing is unavailable");

            const playback = (this.playback = new Audio());
            playback.hidden = true;
            playback.setAttribute("aria-hidden", "true");
            playback.dataset.testid = "microphone-test-audio";
            playback.srcObject = new MediaStream([processor.processedTrack]);
            playback.volume = this.getSnapshot().testVolume / 100;
            document.body.append(playback);
            if (typeof playback.setSinkId === "function") await playback.setSinkId(this.getSnapshot().speakerId);
            if (this.isDisposed || generation !== this.testGeneration) return;
            await playback.play();
            if (this.isDisposed || generation !== this.testGeneration) return;
            this.snapshot.merge({ testing: true, starting: false });
            void this.refreshDevices();
        } catch (error) {
            if (this.isDisposed || generation !== this.testGeneration) return;
            this.stopTest();
            this.fail(error);
        }
    };

    private onMicrophoneEnded = (): void => {
        this.stopTest();
        this.snapshot.merge({ error: _t("settings|voip|microphone_disconnected") });
    };

    private stopTest = (): void => {
        ++this.testGeneration;
        if (this.playback) {
            this.playback.pause();
            this.playback.srcObject = null;
            this.playback.remove();
            this.playback = undefined;
        }
        for (const track of this.stream?.getTracks() ?? []) {
            track.onended = null;
            track.stop();
        }
        this.stream = undefined;
        if (this.processor)
            void this.processor.destroy().catch((error: unknown) => logger.warn("Preview cleanup", error));
        this.processor = undefined;
        this.snapshot.merge({ testing: false, starting: false, levelDb: -100, voiceDetected: false });
    };

    private fail = (error: unknown): void => {
        if (this.isDisposed) return;
        logger.warn("Microphone test failed", error);
        const name = error instanceof Error ? error.name : "";
        this.snapshot.merge({
            error:
                name === "NotAllowedError" || name === "SecurityError"
                    ? _t("settings|voip|microphone_permission_denied")
                    : name === "NotFoundError"
                      ? _t("settings|voip|audio_input_empty")
                      : _t("settings|voip|microphone_test_failed"),
        });
    };
}
