/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Text } from "@vector-im/compound-web";

import { useI18n } from "../../core/i18n/i18nContext";
import { useViewModel } from "../../core/viewmodel";
import { type DesktopVoiceControlsViewModel } from "./DesktopVoiceControlsView";
import styles from "./DesktopVoiceControlsView.module.css";

/** Live transport statistics, with gaps where the call has not supplied a measurement. */
export function VoiceConnectionPanel({ vm }: { vm: DesktopVoiceControlsViewModel }): JSX.Element {
    const { connection } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const points: string[][] = [];
    const ceiling = Math.max(100, ...connection.history.map((value) => value ?? 0));
    let segment: string[] = [];
    for (const [index, value] of connection.history.entries()) {
        if (value === null) {
            if (segment.length) points.push(segment);
            segment = [];
        } else {
            const x = (index / Math.max(1, connection.history.length - 1)) * 300;
            segment.push(`${x},${54 - (value / ceiling) * 48}`);
        }
    }
    if (segment.length) points.push(segment);
    const ping = (value: number | null): string =>
        value === null ? "—" : _t("desktop|voice|ping_value", { value: Math.round(value) });
    const metrics = [
        [_t("desktop|voice|average_ping"), ping(connection.averageRttMs)],
        [_t("desktop|voice|last_ping"), ping(connection.rttMs)],
        [
            _t("desktop|voice|outbound_loss"),
            connection.outboundPacketLossPercent === null
                ? "—"
                : _t("desktop|voice|loss_value", { value: connection.outboundPacketLossPercent.toFixed(1), unit: "%" }),
        ],
    ];
    return (
        <>
            <svg
                className={styles.pingChart}
                viewBox="0 0 300 60"
                role="img"
                aria-label={_t("desktop|voice|ping_history")}
            >
                <line x1="0" x2="300" y1="58" y2="58" className={styles.chartBaseline} />
                {points.map((part) =>
                    part.length === 1 ? (
                        <circle key={part.join(" ")} cx={part[0].split(",")[0]} cy={part[0].split(",")[1]} r="2" />
                    ) : (
                        <polyline key={part.join(" ")} points={part.join(" ")} />
                    ),
                )}
            </svg>
            <dl className={styles.metrics}>
                {metrics.map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
            {connection.rttMs === null && (
                <Text size="sm" className={styles.description}>
                    {_t("desktop|voice|connection_waiting")}
                </Text>
            )}
            <Text size="xs" className={styles.description}>
                {_t("desktop|voice|connection_metrics_hint")}
            </Text>
            {["poor", "bad", "lost"].includes(connection.quality) && (
                <Text size="sm" role="status" className={styles.networkWarning}>
                    {_t("desktop|voice|connection_warning")}
                </Text>
            )}
        </>
    );
}
