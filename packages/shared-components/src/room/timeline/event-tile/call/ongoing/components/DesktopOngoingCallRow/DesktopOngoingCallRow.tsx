/*
 * Copyright 2026 Gabriel
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE in the repository root for full details.
 */

import React, { type JSX, type ReactNode } from "react";

import { useViewModel } from "../../../../../../../core/viewmodel";
import { Flex } from "../../../../../../../core/utils/Flex";
import { Clock } from "../../../../../../../audio/Clock";
import { useI18n } from "../../../../../../../core/i18n/i18nContext";
import type { CallType } from "../../../common";
import type { DurationViewModel } from "../Duration/DurationView";
import { Icon } from "../Icon/Icon";
import { JoinButton } from "../JoinButton/JoinButton";
import styles from "./DesktopOngoingCallRow.module.css";

/** Props for {@link DesktopOngoingCallRow}. */
export interface DesktopOngoingCallRowProps {
    /** Whether the call is a voice or video call; decides the icon. */
    callType: CallType;
    /** What happened, such as "Alice started a voice call.". */
    title: ReactNode;
    /** Supporting detail after the live marker, such as a face pile and how many joined. */
    detail?: ReactNode;
    /** The running length of the call, when known. */
    durationViewModel?: DurationViewModel;
    /** Whether we are in the call already, which hides the join button. */
    isJoined: boolean;
    /** Whether we may join the call. */
    isJoinable: boolean;
    /** Joins the call. */
    join: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

function LiveDuration({ vm }: Readonly<{ vm: DurationViewModel }>): JSX.Element {
    const { duration } = useViewModel(vm);
    return <Clock seconds={duration} hoursMinLength={1} minutesMinLength={1} className={styles.duration} />;
}

/**
 * An ongoing call in the timeline, drawn as a row that matches the call history around it: the call icon in the
 * avatar column with a live pulse, what happened, how long the call has run, and a compact join button.
 *
 * The row carries `data-call-history` so the event tile places it the same way as finished calls.
 */
export function DesktopOngoingCallRow({
    callType,
    title,
    detail,
    durationViewModel,
    isJoined,
    isJoinable,
    join,
}: Readonly<DesktopOngoingCallRowProps>): JSX.Element {
    const { translate: _t } = useI18n();
    return (
        <Flex className={styles.row} align="center" gap="var(--cpd-space-5x)" data-call-history="true">
            <span className={styles.iconFrame} aria-hidden="true">
                <Icon callType={callType} classNames={styles.icon} width={20} height={20} />
            </span>
            <div className={styles.text}>
                <span className={styles.title}>{title}</span>
                <span className={styles.live}>
                    <span className={styles.liveDot} aria-hidden="true" />
                    {_t("timeline|call_tile|ongoing|common|ongoing")}
                    {durationViewModel && <LiveDuration vm={durationViewModel} />}
                </span>
                {detail && <span className={styles.detail}>{detail}</span>}
            </div>
            {!isJoined && <JoinButton className={styles.join} disabled={!isJoinable} callType={callType} join={join} />}
        </Flex>
    );
}
