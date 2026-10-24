/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopInputProfile,
    type DesktopNoiseSuppression,
    type DesktopVoiceVideoSettingsViewSnapshot,
    type DesktopVoiceVideoSettingsViewModel as DesktopVoiceVideoSettingsViewModelInterface,
    type VoiceVideoDevice,
} from "@element-hq/web-shared-components";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { DesktopShortcutManager } from "../../audio/desktop/DesktopShortcutManager";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import { type SettingKey } from "../../settings/Settings";
import MediaDeviceHandler, { MediaDeviceKindEnum } from "../../MediaDeviceHandler";
import { _t } from "../../languageHandler";
import Modal from "../../Modal";
import QuestionDialog from "../../components/views/dialogs/QuestionDialog";
import BugReportDialog from "../../components/views/dialogs/BugReportDialog";
import { UserTab } from "../../components/views/dialogs/UserTab";
import { requestMediaPermissions } from "../../utils/media/requestMediaPermissions";
import { CallStore, CallStoreEvent } from "../../stores/CallStore";
import {
    DESKTOP_VOICE_SOUNDS,
    getDesktopVoiceSoundToggles,
    playDesktopVoiceSound,
    setDesktopVoiceSoundEnabled,
    type DesktopVoiceSound,
} from "../../audio/DesktopVoiceSounds";
import { MicrophoneTest, mediaTestError } from "../../audio/desktop/MicrophoneTest";
import { CameraTest } from "../../audio/desktop/CameraTest";
import {
    describePushToTalkKey,
    formatPushToTalkKey,
    pushToTalkBindingFromEvent,
    pushToTalkBindingFromModifier,
    isModifierCode,
} from "../../audio/desktop/PushToTalk";

interface Props {
    /** Used to switch direct calls on and off. */
    client: MatrixClient;
    /** Moves the settings dialog to another page, such as Notifications. */
    openTab: (tab: UserTab) => void;
}

/** The settings this page edits, so it can follow changes made elsewhere (and by itself). */
const WATCHED_SETTINGS: SettingKey[] = [
    "webrtc_audioinput",
    "webrtc_audiooutput",
    "webrtc_videoinput",
    "webrtc_audio_autoGainControl",
    "webrtc_audio_echoCancellation",
    "VideoView.flipVideoHorizontally",
    "webRtcAllowPeerToPeer",
    "fallbackICEServerAllowed",
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
    "desktopVoiceSoundToggles",
    "desktopVoiceSounds",
    "desktopVoiceSwitchWarning",
    "desktopAlwaysPreviewVideo",
];

/** The settings that return to their default when Voice & Video is reset. */
const RESET_SETTINGS = [
    ["desktopMicrophoneVolume", SettingLevel.DEVICE],
    ["desktopSpeakerVolume", SettingLevel.DEVICE],
    ["desktopInputProfile", SettingLevel.DEVICE],
    ["desktopNoiseSuppression", SettingLevel.DEVICE],
    ["desktopNoiseSuppressionStrength", SettingLevel.DEVICE],
    ["desktopVoiceDetection", SettingLevel.DEVICE],
    ["desktopInputSensitivityAuto", SettingLevel.DEVICE],
    ["desktopInputSensitivity", SettingLevel.DEVICE],
    ["desktopInputMode", SettingLevel.DEVICE],
    ["desktopPushToTalkKey", SettingLevel.DEVICE],
    ["desktopPushToTalkReleaseDelay", SettingLevel.DEVICE],
    ["desktopVoiceSoundToggles", SettingLevel.DEVICE],
    ["desktopVoiceSounds", SettingLevel.DEVICE],
    ["desktopVoiceSwitchWarning", SettingLevel.DEVICE],
    ["desktopAlwaysPreviewVideo", SettingLevel.DEVICE],
    ["VideoView.flipVideoHorizontally", SettingLevel.ACCOUNT],
    ["webrtc_audioinput", SettingLevel.DEVICE],
    ["webrtc_audiooutput", SettingLevel.DEVICE],
    ["webrtc_videoinput", SettingLevel.DEVICE],
] as const satisfies ReadonlyArray<readonly [SettingKey, SettingLevel]>;

/** What a profile other than custom decides for the user, as the custom settings would express it. */
interface ProfilePreset {
    noiseSuppression: DesktopNoiseSuppression;
    noiseSuppressionStrength?: number;
    voiceDetection: boolean;
    sensitivityAuto?: boolean;
}

/** Keep in step with `getMicrophoneGateConfig`, which applies the same choices to calls. */
const PROFILE_PRESETS: Record<Exclude<DesktopInputProfile, "custom">, ProfilePreset> = {
    voice_isolation: {
        noiseSuppression: "enhanced",
        noiseSuppressionStrength: 100,
        voiceDetection: true,
        sensitivityAuto: true,
    },
    studio: { noiseSuppression: "none", voiceDetection: false },
};

/** How often the microphone meter redraws, in ms. Audio arrives far faster than the eye needs. */
const METER_INTERVAL_MS = 50;

/** The sounds that push to talk plays; one switch controls both. */
const PUSH_TO_TALK_SOUNDS: DesktopVoiceSound[] = ["pttActivate", "pttDeactivate"];

/**
 * Drives the desktop Voice & Video settings page. It edits the same settings and devices the calls read, runs
 * the microphone and camera tests, and records the push to talk key. Everything it opens is closed on dispose.
 */
export class DesktopVoiceVideoSettingsViewModel
    extends BaseViewModel<DesktopVoiceVideoSettingsViewSnapshot, Props>
    implements DesktopVoiceVideoSettingsViewModelInterface
{
    private readonly microphoneTest = new MicrophoneTest(
        (level, open, threshold) => this.onMicrophoneLevel(level, open, threshold),
        (status) => {
            if (!this.isDisposed && status !== "active") this.snapshot.merge({ noiseSuppressionProblem: status });
        },
    );
    private readonly cameraTest = new CameraTest();
    private lastMeterUpdate = 0;
    private stopRecording?: () => void;
    private devices?: Awaited<ReturnType<typeof MediaDeviceHandler.getDevices>>;

    public constructor(props: Props) {
        super(props, {
            devicesVisible: false,
            audioInputs: [],
            audioOutputs: [],
            videoInputs: [],
            audioInputId: "",
            audioOutputId: "",
            videoInputId: "",
            microphoneVolume: 100,
            speakerVolume: 100,
            microphoneTest: { active: false, level: null, open: false },
            inputLevel: { level: null, open: false, threshold: null },
            inputProfile: "voice_isolation",
            noiseSuppression: "enhanced",
            noiseSuppressionStrength: 100,
            voiceDetection: true,
            sensitivityAuto: true,
            sensitivity: -50,
            inputMode: "voice_activity",
            pushToTalk: { key: "", recording: false, releaseDelay: 200, soundEnabled: true },
            echoCancellation: true,
            autoGainControl: true,
            voiceChannelSwitchWarning: false,
            videoTest: { active: false, stream: null },
            mirrorVideo: true,
            alwaysPreviewVideo: false,
            sounds: [],
            inCall: false,
        });
        for (const name of WATCHED_SETTINGS) {
            const ref = SettingsStore.watchSetting(name, null, this.onSettingChanged);
            this.disposables.track(() => SettingsStore.unwatchSetting(ref));
        }
        const onCallsChanged = (): void => this.snapshot.merge({ inCall: CallStore.instance.connectedCalls.size > 0 });
        CallStore.instance.on(CallStoreEvent.ConnectedCalls, onCallsChanged);
        this.disposables.track(() => CallStore.instance.off(CallStoreEvent.ConnectedCalls, onCallsChanged));
        navigator.mediaDevices?.addEventListener("devicechange", this.onDevicesChanged);
        this.disposables.track(() =>
            navigator.mediaDevices?.removeEventListener("devicechange", this.onDevicesChanged),
        );
        this.disposables.track(() => this.stopTests());
        this.refreshSettings();
        void this.refreshDevices();
    }

    public override dispose(): void {
        this.stopTests();
        this.stopRecording?.();
        super.dispose();
    }

    private stopTests(): void {
        this.microphoneTest.stop();
        this.cameraTest.stop();
    }

    private readonly onDevicesChanged = (): void => void this.refreshDevices();

    private readonly onSettingChanged = (): void => {
        this.refreshSettings();
        this.microphoneTest.update();
    };

    private onMicrophoneLevel(level: number, open: boolean, threshold: number | null): void {
        const now = performance.now();
        if (this.isDisposed || now - this.lastMeterUpdate < METER_INTERVAL_MS) return;
        this.lastMeterUpdate = now;
        const { microphoneTest } = this.snapshot.current;
        this.snapshot.merge({
            inputLevel: { level, open, threshold },
            microphoneTest: microphoneTest.active ? { ...microphoneTest, level, open } : microphoneTest,
        });
    }

    /**
     * Measures the microphone without playing it back while the page is open, as Discord does, so the input
     * sensitivity always shows where the voice sits. Only once access is granted: it must not prompt by itself.
     */
    private async startLevelMonitor(): Promise<void> {
        if (this.isDisposed || this.microphoneTest.active || !this.snapshot.current.devicesVisible) return;
        try {
            await this.microphoneTest.start({ playback: false });
        } catch (error) {
            logger.debug("Could not measure the microphone level", error);
        }
        // The page may have closed while the microphone was opening.
        if (this.isDisposed) this.microphoneTest.stop();
    }

    private refreshSettings(): void {
        if (this.isDisposed) return;
        const toggles = getDesktopVoiceSoundToggles();
        const canSetFallbackIce = SettingsStore.canSetValue("fallbackICEServerAllowed", null, SettingLevel.DEVICE);
        const inputProfile = SettingsStore.getValue("desktopInputProfile");
        // A preset shows what it does, while the custom settings keep the user's own choices for later.
        const preset: Partial<ProfilePreset> = inputProfile === "custom" ? {} : PROFILE_PRESETS[inputProfile];
        this.snapshot.merge({
            microphoneVolume: SettingsStore.getValue("desktopMicrophoneVolume"),
            speakerVolume: SettingsStore.getValue("desktopSpeakerVolume"),
            inputProfile,
            noiseSuppression: preset.noiseSuppression ?? SettingsStore.getValue("desktopNoiseSuppression"),
            noiseSuppressionStrength:
                preset.noiseSuppressionStrength ?? SettingsStore.getValue("desktopNoiseSuppressionStrength"),
            voiceDetection: preset.voiceDetection ?? SettingsStore.getValue("desktopVoiceDetection"),
            sensitivityAuto: preset.sensitivityAuto ?? SettingsStore.getValue("desktopInputSensitivityAuto"),
            sensitivity: SettingsStore.getValue("desktopInputSensitivity"),
            inputMode: SettingsStore.getValue("desktopInputMode"),
            pushToTalk: {
                key: describePushToTalkKey(SettingsStore.getValue("desktopPushToTalkKey")),
                recording: this.snapshot.current.pushToTalk.recording,
                releaseDelay: SettingsStore.getValue("desktopPushToTalkReleaseDelay"),
                soundEnabled: PUSH_TO_TALK_SOUNDS.every((id) => toggles[id] !== false),
            },
            echoCancellation: MediaDeviceHandler.getAudioEchoCancellation(),
            autoGainControl: MediaDeviceHandler.getAudioAutoGainControl(),
            voiceChannelSwitchWarning: SettingsStore.getValue("desktopVoiceSwitchWarning"),
            mirrorVideo: SettingsStore.getValue("VideoView.flipVideoHorizontally"),
            alwaysPreviewVideo: SettingsStore.getValue("desktopAlwaysPreviewVideo"),
            sounds: DESKTOP_VOICE_SOUNDS.map(({ id, label, extra }) => ({
                id,
                label: _t(label),
                extra,
                enabled: toggles[id] !== false,
            })),
            // Direct calls only exist where legacy calls do; Element Call always goes through a server.
            peerToPeer: this.directCallsPossible() ? SettingsStore.getValue("webRtcAllowPeerToPeer") : undefined,
            fallbackIceServer: canSetFallbackIce ? !!SettingsStore.getValue("fallbackICEServerAllowed") : undefined,
            inCall: CallStore.instance.connectedCalls.size > 0,
        });
        this.refreshSelectedDevices();
    }

    private directCallsPossible(): boolean {
        return SettingsStore.getValue("enableLegacyCallsVoip");
    }

    private async refreshDevices(): Promise<void> {
        let visible = false;
        try {
            visible = await MediaDeviceHandler.hasAnyLabeledDevices();
            this.devices = visible ? await MediaDeviceHandler.getDevices() : undefined;
        } catch (error) {
            logger.warn("Could not list media devices", error);
        }
        if (this.isDisposed) return;
        const list = (kind: MediaDeviceKindEnum): VoiceVideoDevice[] => {
            const devices = this.devices?.[kind].slice(0) ?? [];
            // Adds the "system default" entry when the browser does not report one.
            MediaDeviceHandler.getDefaultDevice(devices);
            return devices.map((device) => ({
                id: device.deviceId ?? "",
                label: device.label || (device.deviceId ? device.deviceId : _t("voip|default_device")),
            }));
        };
        this.snapshot.merge({
            devicesVisible: visible,
            audioInputs: list(MediaDeviceKindEnum.AudioInput),
            audioOutputs: list(MediaDeviceKindEnum.AudioOutput),
            videoInputs: list(MediaDeviceKindEnum.VideoInput),
        });
        this.refreshSelectedDevices();
        void this.startLevelMonitor();
    }

    private refreshSelectedDevices(): void {
        const selected = (stored: string, devices: VoiceVideoDevice[]): string =>
            devices.some((device) => device.id === stored) ? stored : (devices[0]?.id ?? "");
        const { audioInputs, audioOutputs, videoInputs } = this.snapshot.current;
        this.snapshot.merge({
            audioInputId: selected(MediaDeviceHandler.getAudioInput(), audioInputs),
            audioOutputId: selected(MediaDeviceHandler.getAudioOutput(), audioOutputs),
            videoInputId: selected(MediaDeviceHandler.getVideoInput(), videoInputs),
        });
    }

    private async setSetting<K extends SettingKey>(
        name: K,
        value: ReturnType<typeof SettingsStore.getValue<K>>,
    ): Promise<void> {
        await SettingsStore.setValue(
            name,
            null,
            name === "VideoView.flipVideoHorizontally" ? SettingLevel.ACCOUNT : SettingLevel.DEVICE,
            value,
        );
    }

    public requestPermissions = async (): Promise<void> => {
        const stream = await requestMediaPermissions();
        stream?.getTracks().forEach((track) => track.stop());
        await this.refreshDevices();
    };

    private async chooseDevice(id: string, kind: MediaDeviceKindEnum): Promise<void> {
        try {
            await MediaDeviceHandler.instance.setDevice(id, kind);
        } catch (error) {
            logger.error(`Failed to set device ${kind}: ${id}`, error);
        }
        this.refreshSelectedDevices();
        // A running test keeps the device it opened, so open it again on the new one.
        if (kind === MediaDeviceKindEnum.AudioInput && this.microphoneTest.active) await this.reopenMicrophone();
        if (kind === MediaDeviceKindEnum.VideoInput && this.cameraTest.active) await this.startCameraTest();
    }

    public setAudioInput = (id: string): Promise<void> => this.chooseDevice(id, MediaDeviceKindEnum.AudioInput);
    public setAudioOutput = (id: string): Promise<void> => this.chooseDevice(id, MediaDeviceKindEnum.AudioOutput);
    public setVideoInput = (id: string): Promise<void> => this.chooseDevice(id, MediaDeviceKindEnum.VideoInput);

    public setMicrophoneVolume = (percent: number): Promise<void> =>
        this.setSetting("desktopMicrophoneVolume", percent);
    public setSpeakerVolume = (percent: number): Promise<void> => this.setSetting("desktopSpeakerVolume", percent);

    /** Opens the newly chosen microphone, keeping playback as it was. */
    private async reopenMicrophone(): Promise<void> {
        this.microphoneTest.stop();
        if (this.snapshot.current.microphoneTest.active) await this.startMicrophoneTest();
        else await this.startLevelMonitor();
    }

    private async startMicrophoneTest(): Promise<void> {
        this.snapshot.merge({
            microphoneTest: { active: true, level: null, open: false },
            noiseSuppressionProblem: undefined,
        });
        try {
            if (this.microphoneTest.active) await this.microphoneTest.setPlayback(true);
            else await this.microphoneTest.start();
        } catch (error) {
            logger.warn("Could not test the microphone", error);
            if (!this.isDisposed) {
                this.snapshot.merge({
                    microphoneTest: { active: false, level: null, open: false, error: mediaTestError(error) },
                });
            }
        }
    }

    public toggleMicrophoneTest = async (): Promise<void> => {
        if (this.snapshot.current.microphoneTest.active) {
            // Stop hearing yourself, but keep measuring for the input sensitivity.
            await this.microphoneTest.setPlayback(false);
            this.snapshot.merge({ microphoneTest: { active: false, level: null, open: false } });
        } else {
            await this.startMicrophoneTest();
        }
    };

    public setInputProfile = async (profile: DesktopInputProfile): Promise<void> => {
        // Studio sends the microphone as it is, and voice isolation uses every kind of processing. The profile
        // is written last, so that changing the two switches does not look like the user editing them by hand.
        if (profile !== "custom") {
            await MediaDeviceHandler.setAudioAutoGainControl(profile === "voice_isolation");
            await MediaDeviceHandler.setAudioEchoCancellation(profile === "voice_isolation");
        }
        await this.setSetting("desktopInputProfile", profile);
    };

    /**
     * Editing a processing setting by hand leaves a preset profile for custom. The custom settings first take on
     * what the preset was doing, so the only thing that changes is the setting the user edited.
     */
    private async leaveProfile(): Promise<void> {
        const profile = SettingsStore.getValue("desktopInputProfile");
        if (profile === "custom") return;
        const preset = PROFILE_PRESETS[profile];
        await this.setSetting("desktopNoiseSuppression", preset.noiseSuppression);
        await this.setSetting("desktopVoiceDetection", preset.voiceDetection);
        if (preset.noiseSuppressionStrength !== undefined) {
            await this.setSetting("desktopNoiseSuppressionStrength", preset.noiseSuppressionStrength);
        }
        if (preset.sensitivityAuto !== undefined) {
            await this.setSetting("desktopInputSensitivityAuto", preset.sensitivityAuto);
        }
        await this.setSetting("desktopInputProfile", "custom");
    }

    public setNoiseSuppression = async (mode: DesktopNoiseSuppression): Promise<void> => {
        await this.leaveProfile();
        await this.setSetting("desktopNoiseSuppression", mode);
    };
    public setNoiseSuppressionStrength = async (percent: number): Promise<void> => {
        await this.leaveProfile();
        await this.setSetting("desktopNoiseSuppressionStrength", percent);
    };
    public setVoiceDetection = async (enabled: boolean): Promise<void> => {
        await this.leaveProfile();
        await this.setSetting("desktopVoiceDetection", enabled);
    };
    public setSensitivityAuto = async (auto: boolean): Promise<void> => {
        await this.leaveProfile();
        await this.setSetting("desktopInputSensitivityAuto", auto);
    };
    public setSensitivity = async (db: number): Promise<void> => {
        await this.leaveProfile();
        await this.setSetting("desktopInputSensitivity", db);
    };
    public setInputMode = (mode: "voice_activity" | "push_to_talk"): Promise<void> =>
        this.setSetting("desktopInputMode", mode);

    public toggleRecordingPushToTalk = (): void => {
        if (this.stopRecording) {
            this.stopRecording();
            return;
        }
        const resume = DesktopShortcutManager.instance.suspend();
        const finish = (binding?: string): void => {
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp, true);
            this.stopRecording = undefined;
            if (!this.isDisposed) {
                this.snapshot.merge({ pushToTalk: { ...this.snapshot.current.pushToTalk, recording: false } });
            }
            if (binding) void this.setSetting("desktopPushToTalkKey", binding).finally(resume);
            else resume();
        };
        // These run before anything else sees the key, so recording it neither types it nor triggers push to talk.
        const swallow = (event: KeyboardEvent): void => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            swallow(event);
            if (event.code === "Escape") return finish();
            const binding = pushToTalkBindingFromEvent(event);
            if (binding) finish(formatPushToTalkKey(binding));
        };
        // A modifier on its own counts once it is let go without another key having been pressed.
        const onKeyUp = (event: KeyboardEvent): void => {
            swallow(event);
            if (isModifierCode(event.code)) finish(formatPushToTalkKey(pushToTalkBindingFromModifier(event.code)));
        };
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        this.stopRecording = () => finish();
        this.snapshot.merge({ pushToTalk: { ...this.snapshot.current.pushToTalk, recording: true } });
    };

    public clearPushToTalk = (): Promise<void> => this.setSetting("desktopPushToTalkKey", "");
    public setPushToTalkReleaseDelay = (milliseconds: number): Promise<void> =>
        this.setSetting("desktopPushToTalkReleaseDelay", milliseconds);
    public setPushToTalkSound = (enabled: boolean): Promise<void> =>
        setDesktopVoiceSoundEnabled(PUSH_TO_TALK_SOUNDS, enabled);

    public setEchoCancellation = async (enabled: boolean): Promise<void> => {
        await this.leaveProfile();
        await MediaDeviceHandler.setAudioEchoCancellation(enabled);
        this.refreshSettings();
    };
    public setAutoGainControl = async (enabled: boolean): Promise<void> => {
        await this.leaveProfile();
        await MediaDeviceHandler.setAudioAutoGainControl(enabled);
        this.refreshSettings();
    };
    public setVoiceChannelSwitchWarning = (enabled: boolean): Promise<void> =>
        this.setSetting("desktopVoiceSwitchWarning", enabled);

    private async startCameraTest(): Promise<void> {
        try {
            const stream = await this.cameraTest.start();
            if (this.isDisposed) return this.cameraTest.stop();
            this.snapshot.merge({ videoTest: { active: stream !== null, stream } });
        } catch (error) {
            logger.warn("Could not test the camera", error);
            if (!this.isDisposed) {
                this.snapshot.merge({ videoTest: { active: false, stream: null, error: mediaTestError(error) } });
            }
        }
    }

    public toggleVideoTest = async (): Promise<void> => {
        if (this.snapshot.current.videoTest.active) {
            this.cameraTest.stop();
            this.snapshot.merge({ videoTest: { active: false, stream: null } });
        } else {
            await this.startCameraTest();
        }
    };

    public setMirrorVideo = (enabled: boolean): Promise<void> =>
        this.setSetting("VideoView.flipVideoHorizontally", enabled);
    public setAlwaysPreviewVideo = (enabled: boolean): Promise<void> =>
        this.setSetting("desktopAlwaysPreviewVideo", enabled);

    public setSoundEnabled = (id: string, enabled: boolean): Promise<void> =>
        setDesktopVoiceSoundEnabled(id as DesktopVoiceSound, enabled);
    public previewSound = (id: string): Promise<void> =>
        playDesktopVoiceSound(id as DesktopVoiceSound, { preview: true });
    public openNotificationSettings = (): void => this.props.openTab(UserTab.Notifications);
    public openHelp = (): void => this.props.openTab(UserTab.Help);

    public setPeerToPeer = async (enabled: boolean): Promise<void> => {
        await this.setSetting("webRtcAllowPeerToPeer", enabled);
        this.props.client.setForceTURN(!enabled);
    };
    public setFallbackIceServer = (enabled: boolean): Promise<void> =>
        this.setSetting("fallbackICEServerAllowed", enabled);

    public submitDebugLogs = (): void => {
        Modal.createDialog(BugReportDialog, {});
    };

    public resetAll = async (): Promise<void> => {
        const { finished } = Modal.createDialog(QuestionDialog, {
            title: _t("desktop|voice_settings|reset_title"),
            description: _t("desktop|voice_settings|reset_description"),
            button: _t("desktop|voice_settings|reset_confirm"),
            danger: true,
        });
        const [confirmed] = await finished;
        if (!confirmed || this.isDisposed) return;
        this.stopTests();
        this.snapshot.merge({
            microphoneTest: { active: false, level: null, open: false },
            videoTest: { active: false, stream: null },
        });
        for (const [name, level] of RESET_SETTINGS) {
            await SettingsStore.setValue(name, null, level, SettingsStore.getDefaultValue(name));
        }
        // These two also tell the call stack about the change.
        await MediaDeviceHandler.setAudioAutoGainControl(SettingsStore.getDefaultValue("webrtc_audio_autoGainControl"));
        await MediaDeviceHandler.setAudioEchoCancellation(
            SettingsStore.getDefaultValue("webrtc_audio_echoCancellation"),
        );
        this.refreshSettings();
        this.snapshot.merge({ inputLevel: { level: null, open: false, threshold: null } });
        await this.startLevelMonitor();
    };
}
