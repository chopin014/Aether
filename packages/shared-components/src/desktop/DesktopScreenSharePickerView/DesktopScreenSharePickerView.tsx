/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Text } from "@vector-im/compound-web";

import { useI18n } from "../../core/i18n/i18nContext";
import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { RovingTabIndexProvider, RovingTabIndexWrapper } from "../../core/roving";
import type { DesktopCallStagePolicyLimits, DesktopCallStageQualityState } from "../DesktopCallStageView";
import styles from "./DesktopScreenSharePickerView.module.css";

/** A source that the operating system currently permits the user to select. */
export interface DesktopScreenShareSource {
    id: string;
    name: string;
    thumbnailURL: string;
}

/** The source selection and quality preferences displayed before starting a share. */
export interface DesktopScreenSharePickerViewSnapshot {
    step: "source" | "quality";
    tab: "screen" | "window";
    sources: readonly DesktopScreenShareSource[];
    selectedSource: DesktopScreenShareSource | null;
    loading: boolean;
    error: string | null;
    quality: DesktopCallStageQualityState;
    limits: DesktopCallStagePolicyLimits;
}

/** Actions on the source picker; capture begins only after confirmation. */
export interface DesktopScreenSharePickerViewActions {
    selectTab: (tab: "screen" | "window") => void;
    selectSource: (id: string) => void;
    setQuality: (quality: Partial<DesktopCallStageQualityState>) => void;
    next: () => void;
    back: () => void;
    confirm: () => void;
    cancel: () => void;
    refresh: () => Promise<void>;
}

/** View model contract for the desktop source picker. */
export type DesktopScreenSharePickerViewModel = ViewModel<
    DesktopScreenSharePickerViewSnapshot,
    DesktopScreenSharePickerViewActions
>;

/** A source-and-quality dialog body; the owning dialog supplies focus locking and its accessible title. */
export function DesktopScreenSharePickerView({ vm }: { vm: DesktopScreenSharePickerViewModel }): JSX.Element {
    const state = useViewModel(vm);
    const { translate: _t } = useI18n();
    const sourceStep = state.step === "source";
    const choices = (presets: number[], limit: number | null): number[] =>
        [...new Set(limit === null ? presets : [...presets, limit])].sort((a, b) => a - b);
    const resolutions = choices([720, 1080, 1440], state.limits.maxResolutionHeight);
    const framerates = choices([15, 30, 60], state.limits.maxFrameRate);
    const bitrates = choices([1_500_000, 3_500_000, 6_000_000], state.limits.maxBitrate);
    const hasThumbnail = (url: string): boolean => Boolean(url) && !url.endsWith(",");
    return (
        <div className={styles.picker}>
            <Text as="p" size="sm" className={styles.description}>
                {sourceStep ? _t("desktop|share_picker|choose_source") : _t("desktop|share_picker|choose_quality")}
            </Text>
            {sourceStep ? (
                <>
                    <RovingTabIndexProvider handleLoop handleHomeEnd handleLeftRight>
                        {({ onKeyDownHandler }) => (
                            <div
                                role="tablist"
                                tabIndex={-1}
                                aria-label={_t("desktop|share_picker|source_type")}
                                className={styles.tabs}
                                onKeyDown={onKeyDownHandler}
                            >
                                {(["window", "screen"] as const).map((tab) => (
                                    <RovingTabIndexWrapper key={tab}>
                                        {({ ref, isActive, onFocus }) => (
                                            <button
                                                ref={ref}
                                                type="button"
                                                role="tab"
                                                aria-selected={state.tab === tab}
                                                aria-controls="aether-share-sources"
                                                id={`aether-share-${tab}`}
                                                tabIndex={isActive ? 0 : -1}
                                                className={styles.tab}
                                                onFocus={() => {
                                                    onFocus();
                                                    vm.selectTab(tab);
                                                }}
                                                onClick={() => vm.selectTab(tab)}
                                            >
                                                {tab === "window"
                                                    ? _t("desktop|share_picker|applications")
                                                    : _t("desktop|share_picker|screens")}
                                            </button>
                                        )}
                                    </RovingTabIndexWrapper>
                                ))}
                            </div>
                        )}
                    </RovingTabIndexProvider>
                    <div
                        role="tabpanel"
                        id="aether-share-sources"
                        aria-labelledby={`aether-share-${state.tab}`}
                        className={styles.sources}
                    >
                        {state.loading && state.sources.length === 0 && (
                            <Text as="p" size="sm" role="status">
                                {_t("desktop|share_picker|loading")}
                            </Text>
                        )}
                        {state.sources
                            .filter((source) => source.id.startsWith(state.tab))
                            .map((source) => (
                                <button
                                    key={source.id}
                                    type="button"
                                    className={styles.source}
                                    aria-pressed={state.selectedSource?.id === source.id}
                                    onClick={() => vm.selectSource(source.id)}
                                >
                                    {hasThumbnail(source.thumbnailURL) ? (
                                        <img src={source.thumbnailURL} alt="" className={styles.thumbnail} />
                                    ) : (
                                        <span aria-hidden="true" className={styles.thumbnail} />
                                    )}
                                    <Text as="span" size="sm" className={styles.sourceName}>
                                        {source.name}
                                    </Text>
                                </button>
                            ))}
                        {!state.loading &&
                            !state.error &&
                            !state.sources.some((source) => source.id.startsWith(state.tab)) && (
                                <Text as="p" size="sm" className={styles.empty}>
                                    {_t("desktop|share_picker|empty")}
                                </Text>
                            )}
                    </div>
                </>
            ) : (
                <div className={styles.quality}>
                    {state.selectedSource && (
                        <div className={styles.selected}>
                            {hasThumbnail(state.selectedSource.thumbnailURL) && (
                                <img src={state.selectedSource.thumbnailURL} alt="" />
                            )}
                            <Text as="span" size="sm">
                                {state.selectedSource.name}
                            </Text>
                        </div>
                    )}
                    <fieldset>
                        <legend>{_t("desktop|call_stage|resolution_label")}</legend>
                        <div className={styles.options}>
                            {resolutions.map((height) => (
                                <button
                                    key={height}
                                    type="button"
                                    aria-pressed={state.quality.resolutionHeight === height}
                                    disabled={
                                        state.limits.maxResolutionHeight !== null &&
                                        height > state.limits.maxResolutionHeight
                                    }
                                    onClick={() => vm.setQuality({ resolutionHeight: height })}
                                >
                                    {height}p
                                </button>
                            ))}
                            <button
                                type="button"
                                aria-pressed={
                                    state.limits.maxResolutionHeight === null && state.quality.resolutionHeight === null
                                }
                                disabled={state.limits.maxResolutionHeight !== null}
                                onClick={() => vm.setQuality({ resolutionHeight: null })}
                            >
                                {_t("desktop|call_stage|resolution_source")}
                            </button>
                        </div>
                    </fieldset>
                    <fieldset>
                        <legend>{_t("desktop|call_stage|frame_rate_label")}</legend>
                        <div className={styles.options}>
                            {framerates.map((fps) => (
                                <button
                                    key={fps}
                                    type="button"
                                    aria-pressed={state.quality.frameRate === fps}
                                    disabled={state.limits.maxFrameRate !== null && fps > state.limits.maxFrameRate}
                                    onClick={() => vm.setQuality({ frameRate: fps })}
                                >
                                    {fps} FPS
                                </button>
                            ))}
                        </div>
                    </fieldset>
                    <fieldset>
                        <legend>{_t("desktop|call_stage|max_bandwidth_label")}</legend>
                        <div className={styles.options}>
                            <button
                                type="button"
                                aria-pressed={state.quality.maxBitrate === null}
                                onClick={() => vm.setQuality({ maxBitrate: null })}
                            >
                                {_t("desktop|call_stage|bitrate_auto")}
                            </button>
                            {bitrates.map((bitrate) => (
                                <button
                                    key={bitrate}
                                    type="button"
                                    aria-pressed={state.quality.maxBitrate === bitrate}
                                    disabled={state.limits.maxBitrate !== null && bitrate > state.limits.maxBitrate}
                                    onClick={() => vm.setQuality({ maxBitrate: bitrate })}
                                >
                                    {bitrate / 1_000_000} Mbps
                                </button>
                            ))}
                        </div>
                    </fieldset>
                    <Text as="p" size="sm" className={styles.description}>
                        {_t("desktop|share_picker|limits", {
                            height: state.limits.maxResolutionHeight ?? "—",
                            fps: state.limits.maxFrameRate ?? "—",
                        })}
                    </Text>
                    <Text as="p" size="sm" className={styles.description}>
                        {_t("desktop|share_picker|audio_unavailable")}
                    </Text>
                </div>
            )}
            {state.error && (
                <div role="alert" className={styles.error}>
                    <Text as="p" size="sm">
                        {_t("desktop|share_picker|load_error")}
                    </Text>
                    <Button kind="tertiary" onClick={() => void vm.refresh()}>
                        {_t("action|retry")}
                    </Button>
                </div>
            )}
            <div className={styles.footer}>
                <Button kind="tertiary" onClick={sourceStep ? vm.cancel : vm.back}>
                    {sourceStep ? _t("action|cancel") : _t("action|back")}
                </Button>
                <Button
                    kind="primary"
                    onClick={sourceStep ? vm.next : vm.confirm}
                    disabled={!state.selectedSource || state.loading}
                >
                    {sourceStep ? _t("desktop|share_picker|continue") : _t("desktop|share_picker|share")}
                </Button>
            </div>
        </div>
    );
}
