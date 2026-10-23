/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { MicrophoneSettingsView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { MicrophoneSettingsViewModel } from "../../../viewmodels/settings/MicrophoneSettingsViewModel";

/** Connect microphone settings to local capture and persistent device preferences. */
export function MicrophoneSettings(): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new MicrophoneSettingsViewModel());
    return <MicrophoneSettingsView vm={vm} />;
}
