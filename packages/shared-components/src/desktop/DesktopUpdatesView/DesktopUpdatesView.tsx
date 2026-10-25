/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, H2, Text } from "@vector-im/compound-web";
import { DownloadIcon, RestartIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type DesktopUpdateState } from "shared-types";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import styles from "./DesktopUpdatesView.module.css";

/** The current release and update process shown in desktop settings. */
export interface DesktopUpdatesViewSnapshot {
    state: DesktopUpdateState;
    loading: boolean;
}

/** Actions for checking and applying a desktop update. */
export interface DesktopUpdatesViewActions {
    checkForUpdates: () => void;
    restartToUpdate: () => void;
}

/** View model contract for desktop update settings. */
export type DesktopUpdatesViewModel = ViewModel<DesktopUpdatesViewSnapshot, DesktopUpdatesViewActions>;

interface Props {
    /** The model that provides update state and settings actions. */
    vm: DesktopUpdatesViewModel;
}

const RELEASES_URL = "https://github.com/chopin014/Aether/releases/latest";

/** Shows the installed version, background update status, and manual update controls. */
export function DesktopUpdatesView({ vm }: Props): JSX.Element {
    const { translate: _t } = useI18n();
    const { state, loading } = useViewModel(vm);
    const unsupported = !loading && state.status === "unsupported";
    const downloading = state.status === "downloading";
    const ready = state.status === "ready";
    const checking = state.status === "checking";
    const error = state.status === "error";
    const progress = Math.min(100, Math.max(0, state.percent ?? 0));
    const displayedProgress = Math.round(progress);

    let headerDescription: string;
    if (loading) {
        headerDescription = _t("desktop|updates|loading_description");
    } else if (unsupported) {
        headerDescription = _t("desktop|updates|manual_description");
    } else {
        headerDescription = _t("desktop|updates|background_description");
    }

    let unsupportedDescription: string;
    switch (state.reason) {
        case "disabled":
            unsupportedDescription = _t("desktop|updates|unsupported_disabled");
            break;
        case "development":
            unsupportedDescription = _t("desktop|updates|unsupported_development");
            break;
        case "package":
            unsupportedDescription = _t("desktop|updates|unsupported_package");
            break;
        case "platform":
            unsupportedDescription = _t("desktop|updates|unsupported_platform");
            break;
        default:
            unsupportedDescription = _t("desktop|updates|unsupported_platform");
            break;
    }

    let status: string;
    let statusClass = styles.status;
    if (loading) {
        status = _t("desktop|updates|loading");
    } else if (checking) {
        status = _t("desktop|updates|checking");
    } else if (downloading) {
        status = state.version
            ? state.percent === undefined
                ? _t("desktop|updates|downloading", { version: state.version })
                : _t("desktop|updates|downloading_percent", { version: state.version, percent: displayedProgress })
            : state.percent === undefined
              ? _t("desktop|updates|downloading_unknown")
              : _t("desktop|updates|downloading_percent_unknown", { percent: displayedProgress });
    } else if (ready) {
        status = state.version
            ? _t("desktop|updates|ready", { version: state.version })
            : _t("desktop|updates|ready_unknown");
        statusClass = `${styles.status} ${styles.ready}`;
    } else if (error) {
        status = _t("desktop|updates|error");
        statusClass = `${styles.status} ${styles.error}`;
    } else if (unsupported) {
        status = _t("desktop|updates|unsupported");
    } else if (state.lastChecked) {
        status = _t("desktop|updates|current");
    } else {
        status = _t("desktop|updates|idle");
    }

    return (
        <Flex
            as="section"
            className={styles.view}
            direction="column"
            align="stretch"
            gap="var(--cpd-space-6x)"
            aria-labelledby="desktop-updates-title"
        >
            <header className={styles.header}>
                <Flex className={styles.titleRow} align="center" gap="var(--cpd-space-3x)">
                    <span className={styles.icon} aria-hidden="true">
                        <DownloadIcon />
                    </span>
                    <H2 id="desktop-updates-title" size="lg">
                        {_t("desktop|updates|title")}
                    </H2>
                </Flex>
                <Text className={styles.description}>{headerDescription}</Text>
            </header>

            <Flex
                as="article"
                className={styles.card}
                direction="column"
                align="stretch"
                gap="var(--cpd-space-4x)"
                aria-labelledby="desktop-updates-version"
            >
                <div className={styles.version}>
                    <Text className={styles.label}>{_t("desktop|updates|current_version")}</Text>
                    <Text id="desktop-updates-version" weight="semibold">
                        {state.currentVersion || _t("desktop|updates|version_unknown")}
                    </Text>
                </div>

                <Flex
                    className={statusClass}
                    align="center"
                    gap="var(--cpd-space-2x)"
                    role={error ? "alert" : "status"}
                    aria-live={downloading ? "off" : error ? "assertive" : "polite"}
                >
                    {loading || checking || downloading ? <span className={styles.spinner} aria-hidden="true" /> : null}
                    <Text>{status}</Text>
                </Flex>

                {downloading && state.percent !== undefined ? (
                    <div className={styles.progress}>
                        <progress
                            aria-label={_t("desktop|updates|download_progress")}
                            aria-valuetext={_t("desktop|updates|download_progress_value", {
                                percent: displayedProgress,
                            })}
                            max={100}
                            value={progress}
                        />
                    </div>
                ) : null}

                {downloading ? (
                    <Text className={styles.description}>{_t("desktop|updates|downloading_hint")}</Text>
                ) : null}
                {ready ? <Text className={styles.description}>{_t("desktop|updates|ready_on_quit")}</Text> : null}

                {unsupported ? (
                    <div className={styles.manualUpdate}>
                        <Text className={styles.description}>{unsupportedDescription}</Text>
                        <a className={styles.releaseLink} href={RELEASES_URL} target="_blank" rel="noreferrer">
                            {_t("desktop|updates|manual_download")}
                        </a>
                    </div>
                ) : (
                    <Flex className={styles.actions} align="start">
                        {downloading || loading ? null : ready ? (
                            <Button onClick={vm.restartToUpdate} Icon={RestartIcon}>
                                {_t("desktop|updates|restart")}
                            </Button>
                        ) : (
                            <Button
                                onClick={vm.checkForUpdates}
                                disabled={checking}
                                kind={error ? "primary" : "secondary"}
                            >
                                {checking
                                    ? _t("desktop|updates|checking_action")
                                    : error
                                      ? _t("desktop|updates|retry")
                                      : _t("desktop|updates|check")}
                            </Button>
                        )}
                    </Flex>
                )}
            </Flex>
        </Flex>
    );
}
