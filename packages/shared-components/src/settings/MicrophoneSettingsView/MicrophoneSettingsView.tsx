/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type CSSProperties, type JSX, useId } from "react";
import { Button, Heading, Text, Toggle } from "@vector-im/compound-web";

import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import { Box } from "../../core/utils/Box";
import { type ViewModel, useViewModel } from "../../core/viewmodel";
import styles from "./MicrophoneSettingsView.module.css";

/** Devices, saved preferences and live state supplied by the microphone settings view model. */
export interface MicrophoneSettingsViewSnapshot {
    microphones: readonly { id: string; label: string }[];
    speakers: readonly { id: string; label: string }[];
    microphoneId: string;
    speakerId: string;
    /** Microphone gain from 0 to 200 percent; the default is 100. */
    inputVolume: number;
    /** Local test playback from 0 to 100 percent; the default is 50. */
    testVolume: number;
    automaticSensitivity: boolean;
    /** Manual threshold, from -100 to 0 dB. */
    sensitivityDb: number;
    /** Current processed microphone level, from -100 to 0 dB. */
    levelDb: number;
    effectiveThresholdDb: number;
    voiceDetected: boolean;
    testing: boolean;
    starting: boolean;
    /** A translated, actionable error from the view model, or null. */
    error: string | null;
    canSelectOutput: boolean;
}

/** Actions are implemented by the host; the view never opens a microphone or starts playback itself. */
export interface MicrophoneSettingsViewActions {
    setMicrophone: (id: string) => void;
    setSpeaker: (id: string) => void;
    setInputVolume: (volume: number) => void;
    setTestVolume: (volume: number) => void;
    setAutomaticSensitivity: (enabled: boolean) => void;
    setSensitivityDb: (db: number) => void;
    toggleTest: () => void;
}

/** Presentation contract for microphone preferences and an explicitly started local mic test. */
export type MicrophoneSettingsViewModel = ViewModel<MicrophoneSettingsViewSnapshot, MicrophoneSettingsViewActions>;

interface MicrophoneSettingsViewProps {
    /** The host-owned view model, including device selection and test lifecycle actions. */
    vm: MicrophoneSettingsViewModel;
}

/** Presents audio devices, local test playback, a live level meter and microphone sensitivity. */
export function MicrophoneSettingsView({ vm }: Readonly<MicrophoneSettingsViewProps>): JSX.Element {
    const snapshot = useViewModel(vm);
    const { translate: _t } = useI18n();
    const id = useId();
    const active = snapshot.testing && !snapshot.starting && !snapshot.error;
    const level = active ? snapshot.levelDb : -100;
    const status = snapshot.starting
        ? _t("settings|microphone|starting_status")
        : !active
          ? _t("settings|microphone|idle_status")
          : snapshot.voiceDetected
            ? _t("settings|microphone|voice_detected")
            : _t("settings|microphone|below_threshold");

    return (
        <Flex
            as="section"
            direction="column"
            align="stretch"
            gap="var(--cpd-space-6x)"
            className={styles.view}
            aria-labelledby={`${id}-title`}
        >
            <Heading as="h3" size="sm" id={`${id}-title`}>
                {_t("settings|microphone|title")}
            </Heading>

            <Box className={styles.controls}>
                <Flex direction="column" align="stretch" gap="var(--cpd-space-2x)" className={styles.field}>
                    <Text as="label" size="sm" weight="semibold" htmlFor={`${id}-microphone`}>
                        {_t("settings|microphone|input_device")}
                    </Text>
                    <select
                        id={`${id}-microphone`}
                        className={styles.select}
                        value={snapshot.microphoneId}
                        disabled={snapshot.starting || snapshot.microphones.length === 0}
                        onChange={(event) => vm.setMicrophone(event.currentTarget.value)}
                    >
                        {snapshot.microphones.length === 0 && (
                            <option value="">{_t("settings|microphone|system_default")}</option>
                        )}
                        {snapshot.microphones.map((device) => (
                            <option key={device.id} value={device.id}>
                                {device.label}
                            </option>
                        ))}
                    </select>
                </Flex>
                <Flex direction="column" align="stretch" gap="var(--cpd-space-2x)" className={styles.field}>
                    {snapshot.canSelectOutput && snapshot.speakers.length > 0 ? (
                        <>
                            <Text as="label" size="sm" weight="semibold" htmlFor={`${id}-speaker`}>
                                {_t("settings|microphone|test_output_device")}
                            </Text>
                            <select
                                id={`${id}-speaker`}
                                className={styles.select}
                                value={snapshot.speakerId}
                                disabled={snapshot.starting}
                                onChange={(event) => vm.setSpeaker(event.currentTarget.value)}
                            >
                                {snapshot.speakers.map((device) => (
                                    <option key={device.id} value={device.id}>
                                        {device.label}
                                    </option>
                                ))}
                            </select>
                        </>
                    ) : (
                        <>
                            <Text size="sm" weight="semibold">
                                {_t("settings|microphone|test_output_device")}
                            </Text>
                            <Text size="sm" className={styles.secondary}>
                                {_t("settings|microphone|system_output_hint")}
                            </Text>
                        </>
                    )}
                </Flex>
                <Flex direction="column" align="stretch" gap="var(--cpd-space-2x)" className={styles.field}>
                    <Flex justify="space-between" align="baseline" gap="var(--cpd-space-2x)">
                        <Text as="label" size="sm" weight="semibold" htmlFor={`${id}-input-volume`}>
                            {_t("settings|microphone|input_volume")}
                        </Text>
                        <Text as="span" size="sm" className={styles.value} aria-hidden="true">
                            {_t("settings|microphone|percent", { volume: snapshot.inputVolume, percent: "%" })}
                        </Text>
                    </Flex>
                    <input
                        id={`${id}-input-volume`}
                        className={styles.range}
                        type="range"
                        min={0}
                        max={200}
                        step={1}
                        value={snapshot.inputVolume}
                        aria-valuetext={_t("settings|microphone|percent", {
                            volume: snapshot.inputVolume,
                            percent: "%",
                        })}
                        onChange={(event) => vm.setInputVolume(Number(event.currentTarget.value))}
                    />
                </Flex>
                <Flex direction="column" align="stretch" gap="var(--cpd-space-2x)" className={styles.field}>
                    <Flex justify="space-between" align="baseline" gap="var(--cpd-space-2x)">
                        <Text as="label" size="sm" weight="semibold" htmlFor={`${id}-test-volume`}>
                            {_t("settings|microphone|test_playback_volume")}
                        </Text>
                        <Text as="span" size="sm" className={styles.value} aria-hidden="true">
                            {_t("settings|microphone|percent", { volume: snapshot.testVolume, percent: "%" })}
                        </Text>
                    </Flex>
                    <input
                        id={`${id}-test-volume`}
                        className={styles.range}
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={snapshot.testVolume}
                        aria-valuetext={_t("settings|microphone|percent", {
                            volume: snapshot.testVolume,
                            percent: "%",
                        })}
                        onChange={(event) => vm.setTestVolume(Number(event.currentTarget.value))}
                    />
                </Flex>
            </Box>

            <Flex direction="column" align="stretch" gap="var(--cpd-space-3x)" className={styles.testSection}>
                <Heading as="h4" size="sm">
                    {_t("settings|microphone|mic_test")}
                </Heading>
                <Text size="sm" className={styles.secondary} id={`${id}-test-help`}>
                    {_t("settings|microphone|test_help")}
                </Text>
                <Flex align="center" wrap="wrap" gap="var(--cpd-space-4x)">
                    <Button
                        type="button"
                        kind="secondary"
                        size="md"
                        onClick={vm.toggleTest}
                        disabled={snapshot.starting}
                        aria-busy={snapshot.starting}
                        aria-describedby={`${id}-test-help`}
                    >
                        {snapshot.starting
                            ? _t("settings|microphone|starting")
                            : snapshot.testing
                              ? _t("settings|microphone|stop_test")
                              : _t("settings|microphone|mic_test")}
                    </Button>
                    <Box grow="1" className={styles.meterColumn}>
                        <div
                            role="meter"
                            aria-label={_t("settings|microphone|microphone_level")}
                            aria-valuemin={-100}
                            aria-valuemax={0}
                            aria-valuenow={level}
                            aria-valuetext={
                                active
                                    ? _t("settings|microphone|decibels", { db: level })
                                    : _t("settings|microphone|inactive")
                            }
                            aria-describedby={`${id}-threshold`}
                            className={styles.meter}
                            data-active={active}
                            data-voice-detected={active && snapshot.voiceDetected}
                        >
                            {Array.from({ length: 40 }, (_, index) => (
                                <span
                                    key={index}
                                    className={styles.segment}
                                    data-filled={active && index < (level + 100) / 2.5}
                                />
                            ))}
                            <span
                                aria-hidden="true"
                                className={styles.threshold}
                                style={
                                    {
                                        "--threshold-position": `${Math.min(100, Math.max(0, snapshot.effectiveThresholdDb + 100))}%`,
                                    } as CSSProperties
                                }
                            />
                        </div>
                    </Box>
                </Flex>
                <Flex justify="space-between" wrap="wrap" gap="var(--cpd-space-2x)">
                    <Text as="span" size="sm" role="status" className={styles.secondary}>
                        {status}
                    </Text>
                    <Text as="span" size="sm" className={styles.secondary} id={`${id}-threshold`}>
                        {_t("settings|microphone|threshold", { db: snapshot.effectiveThresholdDb })}
                    </Text>
                </Flex>
                {snapshot.error && (
                    <Text size="sm" role="alert" className={styles.error}>
                        {snapshot.error}
                    </Text>
                )}
            </Flex>

            <Flex direction="column" align="stretch" gap="var(--cpd-space-3x)" className={styles.sensitivitySection}>
                <Heading as="h4" size="sm">
                    {_t("settings|microphone|input_sensitivity")}
                </Heading>
                <Flex as="label" align="center" justify="space-between" gap="var(--cpd-space-4x)">
                    <Text as="span" size="sm" weight="medium">
                        {_t("settings|microphone|automatic_sensitivity")}
                    </Text>
                    <Toggle
                        checked={snapshot.automaticSensitivity}
                        aria-describedby={`${id}-sensitivity-help`}
                        onChange={(event) => vm.setAutomaticSensitivity(event.currentTarget.checked)}
                    />
                </Flex>
                <Text size="sm" className={styles.secondary} id={`${id}-sensitivity-help`}>
                    {_t("settings|microphone|automatic_help")}
                </Text>
                {!snapshot.automaticSensitivity && (
                    <Flex direction="column" align="stretch" gap="var(--cpd-space-2x)">
                        <Flex justify="space-between" align="baseline" gap="var(--cpd-space-2x)">
                            <Text as="label" size="sm" weight="medium" htmlFor={`${id}-sensitivity`}>
                                {_t("settings|microphone|manual_sensitivity")}
                            </Text>
                            <Text as="span" size="sm" className={styles.value} aria-hidden="true">
                                {_t("settings|microphone|decibels", { db: snapshot.sensitivityDb })}
                            </Text>
                        </Flex>
                        <input
                            id={`${id}-sensitivity`}
                            className={styles.range}
                            type="range"
                            min={-100}
                            max={0}
                            step={1}
                            value={snapshot.sensitivityDb}
                            aria-valuetext={_t("settings|microphone|decibels", { db: snapshot.sensitivityDb })}
                            aria-describedby={`${id}-manual-help`}
                            onChange={(event) => vm.setSensitivityDb(Number(event.currentTarget.value))}
                        />
                        <Text size="sm" className={styles.secondary} id={`${id}-manual-help`}>
                            {_t("settings|microphone|manual_help")}
                        </Text>
                    </Flex>
                )}
            </Flex>
        </Flex>
    );
}
