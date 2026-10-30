/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";
import OnlineOrUnavailableIcon from "@vector-im/compound-design-tokens/assets/web/icons/presence-solid-8x8";
import OfflineIcon from "@vector-im/compound-design-tokens/assets/web/icons/presence-outline-8x8";
import DNDIcon from "@vector-im/compound-design-tokens/assets/web/icons/presence-strikethrough-8x8";
import { Tooltip } from "@vector-im/compound-web";
import { PresenceGlyph, type PresenceGlyphStatus } from "@element-hq/web-shared-components";
import { UnstableValue } from "matrix-js-sdk/src/NamespacedValue";

import { _t } from "../../../../../../languageHandler";
import { useFeatureEnabled } from "../../../../../../hooks/useSettings";

interface Props {
    className?: string;
    presenceState: string;
    /** Tooltip and accessible name to use instead of the standard name of the state. */
    label?: string;
}

export const BUSY_PRESENCE_NAME = new UnstableValue("busy", "org.matrix.msc3026.busy");

function getIconForPresenceState(state: string): JSX.Element {
    switch (state) {
        case "online":
            return <OnlineOrUnavailableIcon height="8px" width="8px" className="mx_PresenceIconView_online" />;
        case "offline":
            return <OfflineIcon height="8px" width="8px" className="mx_PresenceIconView_offline" />;
        case "unavailable":
        case "io.element.unreachable":
            return <OnlineOrUnavailableIcon height="8px" width="8px" className="mx_PresenceIconView_unavailable" />;
        case BUSY_PRESENCE_NAME.name:
        case BUSY_PRESENCE_NAME.altName:
            return <DNDIcon height="8px" width="8px" className="mx_PresenceIconView_dnd" />;
        default:
            throw new Error(`Presence state "${state}" is unknown.`);
    }
}

/** The desktop shell's shape and colour hook for a state, or throws for an unknown state like the icons above. */
function getDesktopGlyph(state: string): { status: PresenceGlyphStatus; className: string } {
    switch (state) {
        case "online":
            return { status: "online", className: "mx_PresenceIconView_online" };
        case "offline":
            return { status: "offline", className: "mx_PresenceIconView_offline" };
        case "unavailable":
        case "io.element.unreachable":
            return { status: "unavailable", className: "mx_PresenceIconView_unavailable" };
        case BUSY_PRESENCE_NAME.name:
        case BUSY_PRESENCE_NAME.altName:
            return { status: "busy", className: "mx_PresenceIconView_dnd" };
        default:
            throw new Error(`Presence state "${state}" is unknown.`);
    }
}

function getTooltipText(state: string): string {
    switch (state) {
        case "online":
            return _t("presence|online");
        case "offline":
            return _t("presence|offline");
        case "unavailable":
        case "io.element.unreachable":
            return _t("presence|away");
        case BUSY_PRESENCE_NAME.name:
        case BUSY_PRESENCE_NAME.altName:
            return _t("presence|busy");
        default:
            throw new Error(`Presence state "${state}" is unknown.`);
    }
}

const AvatarPresenceIconView: React.FC<Props> = ({ className, presenceState, label }) => {
    const names = classNames("mx_PresenceIconView", className);
    const desktopShell = useFeatureEnabled("feature_desktop_shell");
    return (
        <Tooltip label={label ?? getTooltipText(presenceState)} placement="bottom" isTriggerInteractive={false}>
            <div className={names}>
                {desktopShell ? (
                    <PresenceGlyph width="8px" height="8px" {...getDesktopGlyph(presenceState)} />
                ) : (
                    getIconForPresenceState(presenceState)
                )}
            </div>
        </Tooltip>
    );
};

export default AvatarPresenceIconView;
