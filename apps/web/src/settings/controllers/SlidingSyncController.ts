/*
Copyright 2024 New Vector Ltd.
Copyright 2024 Ed Geraghty <ed@geraghty.family>
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import SettingController from "./SettingController";
import PlatformPeg from "../../PlatformPeg";
import { _t } from "../../languageHandler";
import { SlidingSyncManager } from "../../SlidingSyncManager";
import { SlidingSyncCache } from "../../sliding-sync/SlidingSyncCache";
import { type SettingLevel } from "../SettingLevel";

export default class SlidingSyncController extends SettingController {
    public async onChange(_level: SettingLevel, _roomId: string | null, newValue: unknown): Promise<void> {
        if (!newValue) {
            // Regular sync catches up from where it last stopped, as after a long time offline: what it saved, such
            // as outgoing to-device messages, is kept. The rooms sliding sync saved would be stale if it were turned
            // on again, so they go.
            try {
                await SlidingSyncCache.deleteAll();
            } catch (error) {
                logger.warn("SlidingSyncController: could not delete the rooms sliding sync saved", error);
            }
        }
        PlatformPeg.get()?.reload();
    }

    public get settingDisabled(): boolean | string {
        // It can always be turned off. Turning it on needs a server that offers it.
        if (
            !this.settingsStore.getValue("feature_simplified_sliding_sync") &&
            !SlidingSyncManager.serverSupportsSlidingSync
        ) {
            return _t("labs|sliding_sync_server_no_support");
        }

        return false;
    }
}
