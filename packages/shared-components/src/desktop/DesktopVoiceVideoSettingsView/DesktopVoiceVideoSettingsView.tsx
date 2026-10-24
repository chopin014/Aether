/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useRef, useState } from "react";
import { Alert, Button, H2, H3, RadioInput, Text } from "@vector-im/compound-web";
import {
    ChevronRightIcon,
    MicOnIcon,
    NotificationsIcon,
    VideoCallIcon,
    VolumeOnIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { DeviceSelect, type VoiceVideoDevice } from "./DeviceSelect";
import { LevelMeter } from "./LevelMeter";
import { RangeSlider } from "./RangeSlider";
import { Expander, ToggleRow } from "./Rows";
import styles from "./DesktopVoiceVideoSettingsView.module.css";

export type { VoiceVideoDevice } from "./DeviceSelect";

/** The parts of the page, which the settings sidebar links to. */
export type DesktopVoiceVideoSection = "voice" | "video" | "sounds" | "advanced";

/** The id of a section's heading, for the settings sidebar to scroll to. */
export function desktopVoiceVideoSectionId(section: DesktopVoiceVideoSection): string {
    return `desktop-voice-video-${section}`;
}

/** One cue that can be switched on and off and previewed. */
export interface VoiceVideoSound {
    id: string;
    label: string;
    enabled: boolean;
    /** Shown only after "Show more sounds". */
    extra: boolean;
}

/** What a media test is doing. Both tests stop as soon as the user leaves the page. */
export interface VoiceVideoTestState {
    active: boolean;
    error?: "denied" | "unavailable";
}

export interface DesktopVoiceVideoSettingsViewSnapshot {
    /** False until the browser lets us see device names, which needs permission once. */
    devicesVisible: boolean;
    audioInputs: VoiceVideoDevice[];
    audioOutputs: VoiceVideoDevice[];
    videoInputs: VoiceVideoDevice[];
    audioInputId: string;
    audioOutputId: string;
    videoInputId: string;
    /** Percent, 0 to 100. */
    microphoneVolume: number;
    speakerVolume: number;
    microphoneTest: VoiceVideoTestState & {
        /** Loudness in dB while testing, otherwise null. */
        level: number | null;
        /** Whether the input settings would send this sound. */
        open: boolean;
    };
    inputProfile: "studio" | "custom";
    sensitivityAuto: boolean;
    /** Threshold in dB, -100 to 0. */
    sensitivity: number;
    inputMode: "voice_activity" | "push_to_talk";
    pushToTalk: {
        /** A readable form of the key, empty when none is set. */
        key: string;
        recording: boolean;
        /** Milliseconds. */
        releaseDelay: number;
        soundEnabled: boolean;
    };
    echoCancellation: boolean;
    autoGainControl: boolean;
    voiceChannelSwitchWarning: boolean;
    videoTest: VoiceVideoTestState & { stream: MediaStream | null };
    mirrorVideo: boolean;
    alwaysPreviewVideo: boolean;
    sounds: VoiceVideoSound[];
    /** Only offered where calls can be direct; undefined hides the setting. */
    peerToPeer?: boolean;
    /** Only offered where the account provider does not supply a call assist server. */
    fallbackIceServer?: boolean;
    /** Whether a call is open, in which case device and processing changes wait for the next call. */
    inCall: boolean;
}

export interface DesktopVoiceVideoSettingsViewActions {
    requestPermissions: () => void;
    setAudioInput: (id: string) => void;
    setAudioOutput: (id: string) => void;
    setVideoInput: (id: string) => void;
    setMicrophoneVolume: (percent: number) => void;
    setSpeakerVolume: (percent: number) => void;
    toggleMicrophoneTest: () => void;
    setInputProfile: (profile: "studio" | "custom") => void;
    setSensitivityAuto: (auto: boolean) => void;
    setSensitivity: (db: number) => void;
    setInputMode: (mode: "voice_activity" | "push_to_talk") => void;
    toggleRecordingPushToTalk: () => void;
    clearPushToTalk: () => void;
    setPushToTalkReleaseDelay: (milliseconds: number) => void;
    setPushToTalkSound: (enabled: boolean) => void;
    setEchoCancellation: (enabled: boolean) => void;
    setAutoGainControl: (enabled: boolean) => void;
    setVoiceChannelSwitchWarning: (enabled: boolean) => void;
    toggleVideoTest: () => void;
    setMirrorVideo: (enabled: boolean) => void;
    setAlwaysPreviewVideo: (enabled: boolean) => void;
    setSoundEnabled: (id: string, enabled: boolean) => void;
    previewSound: (id: string) => void;
    openNotificationSettings: () => void;
    setPeerToPeer: (enabled: boolean) => void;
    setFallbackIceServer: (enabled: boolean) => void;
    submitDebugLogs: () => void;
    openHelp: () => void;
    resetAll: () => void;
}

/** Presentation contract for the desktop Voice & Video settings page. */
export type DesktopVoiceVideoSettingsViewModel = ViewModel<
    DesktopVoiceVideoSettingsViewSnapshot,
    DesktopVoiceVideoSettingsViewActions
>;

/** Shows a camera stream. The stream belongs to the view model, so this only attaches and detaches it. */
function VideoPreview({ stream, mirror, label }: { stream: MediaStream; mirror: boolean; label: string }): JSX.Element {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        video.srcObject = stream;
        return () => {
            video.srcObject = null;
        };
    }, [stream]);
    return (
        <video
            ref={ref}
            className={classNames(styles.video, mirror && styles.mirrored)}
            aria-label={label}
            autoPlay
            muted
            playsInline
        />
    );
}

/**
 * The Voice & Video settings in the Discord layout: voice, video, sounds and advanced sections one after the
 * other, each with an uppercase label for its controls. Every control acts on a real setting or device.
 */
export function DesktopVoiceVideoSettingsView({ vm }: { vm: DesktopVoiceVideoSettingsViewModel }): JSX.Element {
    const snapshot = useViewModel(vm);
    const { translate: _t } = useI18n();
    const [advancedVoice, setAdvancedVoice] = useState(false);
    const [moreSounds, setMoreSounds] = useState(false);
    const [diagnostics, setDiagnostics] = useState(false);
    const {
        microphoneTest: micTest,
        videoTest,
        pushToTalk,
        inputProfile,
        inputMode,
        sensitivityAuto,
        sounds,
    } = snapshot;
    // Written out rather than built from the names, so that the string extraction can see every key.
    const profileText = {
        studio: {
            title: _t("desktop|voice_video|profile_studio"),
            description: _t("desktop|voice_video|profile_studio_description"),
        },
        custom: {
            title: _t("desktop|voice_video|profile_custom"),
            description: _t("desktop|voice_video|profile_custom_description"),
        },
    };
    const modeText = {
        voice_activity: _t("desktop|voice_video|mode_voice_activity"),
        push_to_talk: _t("desktop|voice_video|mode_push_to_talk"),
    };
    const shownSounds = sounds.filter((sound) => moreSounds || !sound.extra);
    const extraSounds = sounds.filter((sound) => sound.extra);
    const micError =
        micTest.error === "denied"
            ? _t("desktop|voice_video|mic_test_denied")
            : micTest.error
              ? _t("desktop|voice_video|mic_test_unavailable")
              : null;
    const videoError =
        videoTest.error === "denied"
            ? _t("desktop|voice_video|video_denied")
            : videoTest.error
              ? _t("desktop|voice_video|video_unavailable")
              : null;

    return (
        <div className={styles.view}>
            <section aria-labelledby={desktopVoiceVideoSectionId("voice")}>
                <H2 className={styles.heading} id={desktopVoiceVideoSectionId("voice")}>
                    {_t("desktop|voice_video|section_voice")}
                </H2>
                {!snapshot.devicesVisible && (
                    <Alert
                        type="info"
                        title={_t("desktop|voice_video|permissions_title")}
                        actions={
                            <Button size="md" kind="primary" onClick={vm.requestPermissions}>
                                {_t("desktop|voice_video|permissions_request")}
                            </Button>
                        }
                    >
                        {_t("desktop|voice_video|permissions_description")}
                    </Alert>
                )}
                <div className={styles.columns}>
                    <DeviceSelect
                        label={_t("desktop|voice_video|microphone")}
                        icon={<MicOnIcon />}
                        devices={snapshot.audioInputs}
                        value={snapshot.audioInputId}
                        onChange={vm.setAudioInput}
                    />
                    <DeviceSelect
                        label={_t("desktop|voice_video|speaker")}
                        icon={<VolumeOnIcon />}
                        devices={snapshot.audioOutputs}
                        value={snapshot.audioOutputId}
                        onChange={vm.setAudioOutput}
                    />
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>{_t("desktop|voice_video|microphone_volume")}</span>
                        <RangeSlider
                            label={_t("desktop|voice_video|microphone_volume")}
                            value={snapshot.microphoneVolume}
                            min={0}
                            max={100}
                            valueText={`${snapshot.microphoneVolume}%`}
                            onChange={vm.setMicrophoneVolume}
                        />
                    </div>
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>{_t("desktop|voice_video|speaker_volume")}</span>
                        <RangeSlider
                            label={_t("desktop|voice_video|speaker_volume")}
                            value={snapshot.speakerVolume}
                            min={0}
                            max={100}
                            valueText={`${snapshot.speakerVolume}%`}
                            onChange={vm.setSpeakerVolume}
                        />
                    </div>
                </div>
                <div className={styles.test}>
                    <Button kind="primary" size="md" onClick={vm.toggleMicrophoneTest}>
                        {micTest.active
                            ? _t("desktop|voice_video|mic_test_stop")
                            : _t("desktop|voice_video|mic_test_start")}
                    </Button>
                    <LevelMeter
                        label={_t("desktop|voice_video|mic_level")}
                        level={micTest.active ? micTest.level : null}
                        open={micTest.open}
                    />
                </div>
                {micTest.active && <p className={styles.description}>{_t("desktop|voice_video|mic_test_hint")}</p>}
                {micError && (
                    <Text size="md" role="alert" className={styles.error}>
                        {micError}
                    </Text>
                )}
                {snapshot.inCall && <p className={styles.description}>{_t("desktop|voice_video|in_call_hint")}</p>}

                <hr className={styles.divider} />

                <div role="radiogroup" aria-labelledby="desktop-input-profile" className={styles.group}>
                    <H3 className={styles.fieldLabel} id="desktop-input-profile">
                        {_t("desktop|voice_video|input_profile")}
                    </H3>
                    {(["studio", "custom"] as const).map((profile) => (
                        <label
                            key={profile}
                            htmlFor={`desktop-profile-${profile}-input`}
                            className={classNames(styles.card, inputProfile === profile && styles.cardSelected)}
                        >
                            <RadioInput
                                id={`desktop-profile-${profile}-input`}
                                name="desktop-input-profile"
                                aria-labelledby={`desktop-profile-${profile}`}
                                aria-describedby={`desktop-profile-${profile}-description`}
                                checked={inputProfile === profile}
                                onChange={() => vm.setInputProfile(profile)}
                            />
                            <span>
                                <span className={styles.rowLabel} id={`desktop-profile-${profile}`}>
                                    {profileText[profile].title}
                                </span>
                                <span className={styles.description} id={`desktop-profile-${profile}-description`}>
                                    {profileText[profile].description}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>

                <div className={styles.group}>
                    <H3 className={styles.rowLabel}>{_t("desktop|voice_video|sensitivity")}</H3>
                    <p className={styles.description}>{_t("desktop|voice_video|sensitivity_description")}</p>
                    <ToggleRow
                        id="desktop-sensitivity-auto"
                        label={_t("desktop|voice_video|sensitivity_auto")}
                        checked={sensitivityAuto}
                        disabled={inputProfile === "studio"}
                        onChange={vm.setSensitivityAuto}
                    />
                    <RangeSlider
                        label={_t("desktop|voice_video|sensitivity_slider")}
                        value={snapshot.sensitivity}
                        min={-100}
                        max={0}
                        valueText={_t("desktop|voice_video|sensitivity_value", { db: snapshot.sensitivity })}
                        disabled={sensitivityAuto || inputProfile === "studio"}
                        sensitivity={{ level: micTest.active ? micTest.level : null }}
                        onChange={vm.setSensitivity}
                    />
                </div>

                <div role="radiogroup" aria-labelledby="desktop-input-mode" className={styles.group}>
                    <H3 className={styles.fieldLabel} id="desktop-input-mode">
                        {_t("desktop|voice_video|input_mode")}
                    </H3>
                    {(["voice_activity", "push_to_talk"] as const).map((mode) => (
                        <label
                            key={mode}
                            htmlFor={`desktop-mode-${mode}-input`}
                            className={classNames(styles.card, inputMode === mode && styles.cardSelected)}
                        >
                            <RadioInput
                                id={`desktop-mode-${mode}-input`}
                                name="desktop-input-mode"
                                aria-labelledby={`desktop-mode-${mode}`}
                                checked={inputMode === mode}
                                onChange={() => vm.setInputMode(mode)}
                            />
                            <span className={styles.rowLabel} id={`desktop-mode-${mode}`}>
                                {modeText[mode]}
                            </span>
                        </label>
                    ))}
                </div>
                {inputMode === "push_to_talk" && (
                    <div className={styles.group}>
                        <span className={styles.fieldLabel}>{_t("desktop|voice_video|ptt_shortcut")}</span>
                        <div className={styles.keybind}>
                            <kbd className={styles.key} data-testid="ptt-key">
                                {pushToTalk.recording
                                    ? _t("desktop|voice_video|ptt_recording")
                                    : pushToTalk.key || _t("desktop|voice_video|ptt_not_set")}
                            </kbd>
                            <Button kind="secondary" size="md" onClick={vm.toggleRecordingPushToTalk}>
                                {pushToTalk.recording
                                    ? _t("desktop|voice_video|ptt_stop_recording")
                                    : _t("desktop|voice_video|ptt_record")}
                            </Button>
                            {pushToTalk.key !== "" && !pushToTalk.recording && (
                                <Button kind="tertiary" size="md" onClick={vm.clearPushToTalk}>
                                    {_t("desktop|voice_video|ptt_clear")}
                                </Button>
                            )}
                        </div>
                        <p className={styles.description}>
                            {pushToTalk.key === ""
                                ? _t("desktop|voice_video|ptt_needs_key")
                                : _t("desktop|voice_video|ptt_focus_note")}
                        </p>
                        <span className={styles.fieldLabel}>{_t("desktop|voice_video|ptt_release_delay")}</span>
                        <RangeSlider
                            label={_t("desktop|voice_video|ptt_release_delay")}
                            value={pushToTalk.releaseDelay}
                            min={0}
                            max={2000}
                            step={20}
                            valueText={_t("desktop|voice_video|ptt_release_delay_value", {
                                ms: pushToTalk.releaseDelay,
                            })}
                            onChange={vm.setPushToTalkReleaseDelay}
                        />
                        <p className={styles.description}>
                            {_t("desktop|voice_video|ptt_release_delay_value", { ms: pushToTalk.releaseDelay })}
                        </p>
                        <ToggleRow
                            id="desktop-ptt-sound"
                            label={_t("desktop|voice_video|ptt_sound")}
                            checked={pushToTalk.soundEnabled}
                            onChange={vm.setPushToTalkSound}
                        />
                    </div>
                )}

                <ToggleRow
                    id="desktop-echo-cancellation"
                    label={_t("desktop|voice_video|echo_cancellation")}
                    description={_t("desktop|voice_video|echo_cancellation_description")}
                    checked={snapshot.echoCancellation}
                    onChange={vm.setEchoCancellation}
                />

                <Expander
                    id="desktop-advanced-voice"
                    title={_t("desktop|voice_video|advanced_voice")}
                    description={_t("desktop|voice_video|advanced_voice_description")}
                    expanded={advancedVoice}
                    onToggle={() => setAdvancedVoice(!advancedVoice)}
                >
                    <ToggleRow
                        id="desktop-auto-gain"
                        label={_t("desktop|voice_video|auto_gain")}
                        description={_t("desktop|voice_video|auto_gain_description")}
                        checked={snapshot.autoGainControl}
                        onChange={vm.setAutoGainControl}
                    />
                    <ToggleRow
                        id="desktop-switch-warning"
                        label={_t("desktop|voice_video|switch_warning")}
                        description={_t("desktop|voice_video|switch_warning_description")}
                        checked={snapshot.voiceChannelSwitchWarning}
                        onChange={vm.setVoiceChannelSwitchWarning}
                    />
                </Expander>
            </section>

            <hr className={styles.divider} />

            <section aria-labelledby={desktopVoiceVideoSectionId("video")}>
                <H2 className={styles.heading} id={desktopVoiceVideoSectionId("video")}>
                    {_t("desktop|voice_video|section_video")}
                </H2>
                <DeviceSelect
                    label={_t("desktop|voice_video|camera")}
                    icon={<VideoCallIcon />}
                    devices={snapshot.videoInputs}
                    value={snapshot.videoInputId}
                    onChange={vm.setVideoInput}
                />
                <div className={styles.preview}>
                    {videoTest.active && snapshot.videoTest.stream ? (
                        <VideoPreview
                            stream={snapshot.videoTest.stream}
                            mirror={snapshot.mirrorVideo}
                            label={_t("desktop|voice_video|video_preview")}
                        />
                    ) : (
                        <p className={styles.previewPlaceholder}>
                            {videoError ?? _t("desktop|voice_video|video_placeholder")}
                        </p>
                    )}
                </div>
                <Button kind="primary" size="md" onClick={vm.toggleVideoTest}>
                    {videoTest.active
                        ? _t("desktop|voice_video|video_test_stop")
                        : _t("desktop|voice_video|video_test_start")}
                </Button>
                <ToggleRow
                    id="desktop-mirror-video"
                    label={_t("desktop|voice_video|mirror")}
                    description={_t("desktop|voice_video|mirror_description")}
                    checked={snapshot.mirrorVideo}
                    onChange={vm.setMirrorVideo}
                />
                <ToggleRow
                    id="desktop-always-preview"
                    label={_t("desktop|voice_video|always_preview")}
                    description={_t("desktop|voice_video|always_preview_description")}
                    checked={snapshot.alwaysPreviewVideo}
                    onChange={vm.setAlwaysPreviewVideo}
                />
            </section>

            <hr className={styles.divider} />

            <section aria-labelledby={desktopVoiceVideoSectionId("sounds")}>
                <H2 className={styles.heading} id={desktopVoiceVideoSectionId("sounds")}>
                    {_t("desktop|voice_video|section_sounds")}
                </H2>
                <ul className={styles.sounds}>
                    {shownSounds.map((sound) => (
                        <li key={sound.id} className={styles.sound}>
                            <ToggleRow
                                id={`desktop-sound-${sound.id}`}
                                label={sound.label}
                                checked={sound.enabled}
                                onChange={(enabled) => vm.setSoundEnabled(sound.id, enabled)}
                            />
                            <button
                                type="button"
                                className={styles.link}
                                aria-label={_t("desktop|voice_video|preview_sound_for", { sound: sound.label })}
                                onClick={() => vm.previewSound(sound.id)}
                            >
                                {_t("desktop|voice_video|preview_sound")}
                            </button>
                        </li>
                    ))}
                </ul>
                {extraSounds.length > 0 && (
                    <Expander
                        id="desktop-more-sounds"
                        title={
                            moreSounds
                                ? _t("desktop|voice_video|sounds_show_fewer")
                                : _t("desktop|voice_video|sounds_show_more", { count: extraSounds.length })
                        }
                        description={_t("desktop|voice_video|sounds_more_description", {
                            first: extraSounds[0].label,
                            second: extraSounds[1]?.label ?? "",
                            third: extraSounds[2]?.label ?? "",
                        })}
                        expanded={moreSounds}
                        onToggle={() => setMoreSounds(!moreSounds)}
                    >
                        {null}
                    </Expander>
                )}
                <p className={styles.description}>
                    {_t("desktop|voice_video|sounds_notifications_note")}{" "}
                    <button type="button" className={styles.link} onClick={vm.openNotificationSettings}>
                        {_t("desktop|voice_video|notifications_title")}
                    </button>
                </p>
                <H3 className={styles.fieldLabel}>{_t("desktop|voice_video|related_settings")}</H3>
                <button type="button" className={styles.related} onClick={vm.openNotificationSettings}>
                    <span className={styles.relatedIcon}>
                        <NotificationsIcon />
                    </span>
                    <span>
                        <span className={styles.rowLabel}>{_t("desktop|voice_video|notifications_title")}</span>
                        <span className={styles.description}>
                            {_t("desktop|voice_video|notifications_description")}
                        </span>
                    </span>
                    <ChevronRightIcon className={styles.relatedChevron} />
                </button>
            </section>

            <hr className={styles.divider} />

            <section aria-labelledby={desktopVoiceVideoSectionId("advanced")}>
                <H2 className={styles.heading} id={desktopVoiceVideoSectionId("advanced")}>
                    {_t("desktop|voice_video|section_advanced")}
                </H2>
                {snapshot.peerToPeer !== undefined && (
                    <ToggleRow
                        id="desktop-peer-to-peer"
                        label={_t("desktop|voice_video|peer_to_peer")}
                        description={_t("desktop|voice_video|peer_to_peer_description")}
                        checked={snapshot.peerToPeer}
                        onChange={vm.setPeerToPeer}
                    />
                )}
                {snapshot.fallbackIceServer !== undefined && (
                    <ToggleRow
                        id="desktop-fallback-ice"
                        label={_t("desktop|voice_video|fallback_ice")}
                        description={_t("desktop|voice_video|fallback_ice_description")}
                        checked={snapshot.fallbackIceServer}
                        onChange={vm.setFallbackIceServer}
                    />
                )}
                <Expander
                    id="desktop-diagnostics"
                    title={_t("desktop|voice_video|diagnostics")}
                    description={_t("desktop|voice_video|diagnostics_description")}
                    expanded={diagnostics}
                    onToggle={() => setDiagnostics(!diagnostics)}
                >
                    <div className={styles.buttons}>
                        <Button kind="secondary" size="md" onClick={vm.submitDebugLogs}>
                            {_t("desktop|voice_video|submit_logs")}
                        </Button>
                        <Button kind="tertiary" size="md" onClick={vm.openHelp}>
                            {_t("desktop|voice_video|open_help")}
                        </Button>
                    </div>
                </Expander>
                <div className={styles.row}>
                    <div className={styles.rowText}>
                        <H3 className={styles.rowLabel}>{_t("desktop|voice_video|reset_title")}</H3>
                        <p className={styles.description}>{_t("desktop|voice_video|reset_description")}</p>
                    </div>
                    <Button kind="secondary" destructive size="md" onClick={vm.resetAll}>
                        {_t("desktop|voice_video|reset")}
                    </Button>
                </div>
            </section>
        </div>
    );
}
