/*
Copyright 2024 New Vector Ltd.
Copyright 2017 Vector Creations Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { _t } from "./languageHandler";

/** The highest standard role badge for a Matrix power level, shared by member tiles and desktop groups. */
export function getPowerLevelRole(powerLevel: number): { level: number; label: string } | undefined {
    if (powerLevel === Infinity) return { level: Infinity, label: _t("power_level|creator") };
    if (powerLevel >= 100) return { level: 100, label: _t("power_level|admin") };
    if (powerLevel >= 50) return { level: 50, label: _t("power_level|moderator") };
    return undefined;
}

export function levelRoleMap(usersDefault: number): Record<number | "undefined", string> {
    return {
        undefined: _t("power_level|default"),
        0: _t("power_level|restricted"),
        [usersDefault]: _t("power_level|default"),
        50: _t("power_level|moderator"),
        100: _t("power_level|admin"),
    };
}

export function textualPowerLevel(level: number, usersDefault: number): string {
    const LEVEL_ROLE_MAP = levelRoleMap(usersDefault);
    if (LEVEL_ROLE_MAP[level]) {
        return LEVEL_ROLE_MAP[level];
    } else {
        return _t("power_level|custom", { level });
    }
}
