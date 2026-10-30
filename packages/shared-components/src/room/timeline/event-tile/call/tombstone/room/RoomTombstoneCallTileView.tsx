/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { VoiceCallSolidIcon, VideoCallSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import classnames from "classnames";

import { useViewModel, type ViewModel } from "../../../../../../core/viewmodel";
import { Flex } from "../../../../../../core/utils/Flex";
import styles from "../common.module.css";
import { CallType } from "../../common";
import { useI18n } from "../../../../../../core/i18n/i18nContext";

export type RoomTombstoneCallTileViewSnapshot = {
    /**
     * Time when this call was started.
     */
    timestamp: string;
    /** Display name of the person who started the call. */
    startedByDisplayName: string;
    /** Whether the call used voice or video. */
    type: CallType;
};

export type RoomTombstoneCallTileViewModel = ViewModel<RoomTombstoneCallTileViewSnapshot>;

export interface CallStartedTileViewProps {
    vm: RoomTombstoneCallTileViewModel;

    /**
     * Additional class names for this component.
     */
    className?: string;
}

/**
 * Renders the tombstone content for a call in a room.
 */
export function RoomTombstoneCallTileView({ vm, className }: CallStartedTileViewProps): React.ReactNode {
    const { translate: _t } = useI18n();
    const { timestamp, startedByDisplayName, type } = useViewModel(vm);
    const Icon = type === CallType.Voice ? VoiceCallSolidIcon : VideoCallSolidIcon;
    const classNames = classnames(className, styles.container);
    return (
        <Flex className={classNames} align="center" gap="var(--cpd-space-5x)" data-call-history="true">
            <Icon className={styles.icon} width={20} height={20} aria-hidden="true" />
            <div className={styles.title}>
                {type === CallType.Voice
                    ? _t(
                          "timeline|call_tile|tombstone|voice_started",
                          { name: startedByDisplayName },
                          {
                              b: (name) => <strong className={styles.caller}>{name}</strong>,
                          },
                      )
                    : _t(
                          "timeline|call_tile|tombstone|video_started",
                          { name: startedByDisplayName },
                          {
                              b: (name) => <strong className={styles.caller}>{name}</strong>,
                          },
                      )}
                <wbr />
                <span className={styles.time}>{timestamp}</span>
            </div>
        </Flex>
    );
}
