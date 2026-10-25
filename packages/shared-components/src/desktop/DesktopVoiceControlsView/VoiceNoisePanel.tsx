/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Text, ToggleInput } from "@vector-im/compound-web";

import { useI18n } from "../../core/i18n/i18nContext";
import { useViewModel } from "../../core/viewmodel";
import { LevelMeter } from "../DesktopVoiceVideoSettingsView/LevelMeter";
import { RangeSlider } from "../DesktopVoiceVideoSettingsView/RangeSlider";
import { type DesktopVoiceControlsViewModel } from "./DesktopVoiceControlsView";
import styles from "./DesktopVoiceControlsView.module.css";

/** The quick noise controls share the call's settings and the settings page's processed microphone test. */
export function VoiceNoisePanel({ vm }: { vm: DesktopVoiceControlsViewModel }): JSX.Element {
    const { noiseSuppression, noiseSuppressionStrength, microphoneTest, noiseSuppressionProblem, busy } =
        useViewModel(vm);
    const { translate: _t } = useI18n();
    return (
        <>
            <div className={styles.panelRow}>
                <Text as="label" htmlFor="desktop-quick-noise" size="md" weight="semibold">
                    {_t("desktop|voice_video|noise_suppression")}
                </Text>
                <ToggleInput
                    id="desktop-quick-noise"
                    checked={noiseSuppression}
                    disabled={busy}
                    onChange={(event) => void vm.setNoiseSuppression(event.target.checked)}
                />
            </div>
            <Text size="sm" className={styles.description}>
                {_t("desktop|voice|noise_suppression_description")}
            </Text>
            <div className={styles.strength}>
                <div className={styles.panelRow}>
                    <Text size="sm" weight="semibold">
                        {_t("desktop|voice_video|noise_suppression_strength")}
                    </Text>
                    <Text size="sm" className={styles.numeric}>
                        {noiseSuppressionStrength}%
                    </Text>
                </div>
                <RangeSlider
                    label={_t("desktop|voice_video|noise_suppression_strength")}
                    value={noiseSuppressionStrength}
                    min={0}
                    max={100}
                    valueText={`${noiseSuppressionStrength}%`}
                    disabled={!noiseSuppression}
                    onChange={(value) => void vm.setNoiseSuppressionStrength(value)}
                />
                <div className={styles.rangeLabels} aria-hidden="true">
                    <span>0</span>
                    <span>100</span>
                </div>
            </div>
            {noiseSuppressionProblem && (
                <Text size="sm" role="alert" className={styles.error}>
                    {_t(
                        noiseSuppressionProblem === "overloaded"
                            ? "desktop|voice_video|noise_suppression_overloaded"
                            : "desktop|voice_video|noise_suppression_failed",
                    )}
                </Text>
            )}
            <div className={styles.testSection}>
                <Text size="md" weight="semibold">
                    {_t("desktop|voice|microphone_test")}
                </Text>
                <div className={styles.testRow}>
                    <Button kind="secondary" size="md" onClick={() => void vm.toggleMicrophoneTest()}>
                        {_t(
                            microphoneTest.active
                                ? "desktop|voice_video|mic_test_stop"
                                : "desktop|voice_video|mic_test_start",
                        )}
                    </Button>
                    <LevelMeter
                        label={_t("desktop|voice_video|mic_level")}
                        level={microphoneTest.level}
                        open={microphoneTest.open}
                    />
                </div>
                <Text size="xs" className={styles.description}>
                    {_t("desktop|voice|microphone_test_hint")}
                </Text>
                {microphoneTest.error && (
                    <Text size="sm" role="alert" className={styles.error}>
                        {_t(
                            microphoneTest.error === "denied"
                                ? "desktop|voice_video|mic_test_denied"
                                : "desktop|voice_video|mic_test_unavailable",
                        )}
                    </Text>
                )}
            </div>
            <Text size="xs" className={styles.localProcessing}>
                {_t("desktop|voice|noise_suppression_local")}
            </Text>
        </>
    );
}
