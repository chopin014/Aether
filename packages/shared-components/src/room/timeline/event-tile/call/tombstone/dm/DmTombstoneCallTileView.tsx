/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import {
    VideoCallSolidIcon,
    VideoCallDeclinedSolidIcon,
    VoiceCallDeclinedSolidIcon,
    VoiceCallSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import classnames from "classnames";

import { useViewModel, type ViewModel } from "../../../../../../core/viewmodel";
import { Flex } from "../../../../../../core/utils/Flex";
import styles from "../common.module.css";
import { useI18n } from "../../../../../../core/i18n/i18nContext";
import { CallDirection, CallType } from "../../common";
import { type RoomTombstoneCallTileViewSnapshot } from "../room/RoomTombstoneCallTileView";

export interface DmTombstoneCallTileViewSnapshot extends RoomTombstoneCallTileViewSnapshot {
    /**
     * Whether this is an incoming or outgoing call.
     */
    callDirection: CallDirection;

    /**
     * Whether this call was declined.
     */
    isCallDeclined: boolean;
}

export type DmTombstoneCallTileViewModel = ViewModel<DmTombstoneCallTileViewSnapshot>;

export interface DmTombstoneCallTileViewProps {
    vm: DmTombstoneCallTileViewModel;

    /**
     * Additional class names for this component.
     */
    className?: string;
}

function getIcon(type: CallType, isCallDeclined: boolean): React.ReactNode {
    const VideoIcon = isCallDeclined ? VideoCallDeclinedSolidIcon : VideoCallSolidIcon;
    const VoiceIcon = isCallDeclined ? VoiceCallDeclinedSolidIcon : VoiceCallSolidIcon;
    switch (type) {
        case CallType.Video:
            return (
                <VideoIcon
                    className={classnames(styles.icon, { [styles.declined]: isCallDeclined })}
                    width={20}
                    height={20}
                    aria-hidden="true"
                />
            );
        case CallType.Voice:
            return (
                <VoiceIcon
                    className={classnames(styles.icon, { [styles.declined]: isCallDeclined })}
                    width={20}
                    height={20}
                    aria-hidden="true"
                />
            );
    }
}

/**
 * Renders the tombstone content for a tile in a DM.
 */
export function DmTombstoneCallTileView({ vm, className }: DmTombstoneCallTileViewProps): React.ReactNode {
    const snapshot = useViewModel(vm);
    const { type, timestamp, isCallDeclined } = snapshot;
    const classNames = classnames(className, styles.container);
    return (
        <Flex className={classNames} align="center" gap="var(--cpd-space-5x)" data-call-history="true">
            {getIcon(type, isCallDeclined)}
            <div className={styles.title}>
                {isCallDeclined ? <DeclinedContent snapshot={snapshot} /> : <NormalContent snapshot={snapshot} />}
                <wbr />
                <span className={styles.time}>{timestamp}</span>
            </div>
        </Flex>
    );
}

function NormalContent(props: { snapshot: DmTombstoneCallTileViewSnapshot }): React.ReactNode {
    const { type, startedByDisplayName } = props.snapshot;
    const { translate: _t } = useI18n();
    return type === CallType.Voice
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
          );
}

function DeclinedContent(props: { snapshot: DmTombstoneCallTileViewSnapshot }): React.ReactNode {
    const { callDirection } = props.snapshot;
    const { translate: _t } = useI18n();
    return callDirection === CallDirection.Incoming
        ? _t("timeline|call_tile|declined|call_declined_by_us")
        : _t("timeline|call_tile|declined|call_declined");
}
