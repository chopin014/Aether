/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type MessageDisplay,
    type MessageDisplayViewActions,
    type MessageDisplayViewSnapshot,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";

import { SettingLevel } from "../../settings/SettingLevel";
import SettingsStore from "../../settings/SettingsStore";

/** The spacings offered between message groups, in pixels. */
export const MESSAGE_GROUP_SPACING_OPTIONS = [0, 4, 8, 16, 24];

/** Holds the desktop shell's message layout and group spacing, and saves changes to them. */
export class MessageDisplayViewModel
    extends BaseViewModel<MessageDisplayViewSnapshot, undefined>
    implements MessageDisplayViewActions
{
    public constructor() {
        super(undefined, MessageDisplayViewModel.computeSnapshot());

        // Another device or tab may change these too.
        const watchers = [
            SettingsStore.watchSetting("useCompactLayout", null, this.onSettingChanged),
            SettingsStore.watchSetting("desktopMessageGroupSpacing", null, this.onSettingChanged),
        ];
        this.disposables.track(() => watchers.forEach((ref) => SettingsStore.unwatchSetting(ref)));
    }

    private static computeSnapshot(): MessageDisplayViewSnapshot {
        return {
            display: SettingsStore.getValue("useCompactLayout") ? "compact" : "cozy",
            groupSpacing: SettingsStore.getValue("desktopMessageGroupSpacing"),
            groupSpacingOptions: MESSAGE_GROUP_SPACING_OPTIONS,
        };
    }

    private readonly onSettingChanged = (): void => {
        this.snapshot.set(MessageDisplayViewModel.computeSnapshot());
    };

    /** Switches between cozy and compact messages. */
    public setDisplay = (display: MessageDisplay): void => {
        this.snapshot.merge({ display });
        SettingsStore.setValue("useCompactLayout", null, SettingLevel.DEVICE, display === "compact").catch((error) =>
            logger.error("Failed to save the message display", error),
        );
    };

    /** Changes the space between message groups. */
    public setGroupSpacing = (groupSpacing: number): void => {
        this.snapshot.merge({ groupSpacing });
        SettingsStore.setValue("desktopMessageGroupSpacing", null, SettingLevel.ACCOUNT, groupSpacing).catch((error) =>
            logger.error("Failed to save the message group spacing", error),
        );
    };
}
