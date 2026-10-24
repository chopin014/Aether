/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useContext } from "react";
import { DesktopVoiceVideoSettingsView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../../../../../contexts/MatrixClientContext";
import { UserSettingsNavigationContext } from "../../../../../contexts/UserSettingsNavigationContext";
import { DesktopVoiceVideoSettingsViewModel } from "../../../../../viewmodels/settings/DesktopVoiceVideoSettingsViewModel";

/** The Voice & Video page of the desktop shell, which owns the model and closes its tests when it unmounts. */
export function DesktopVoiceVideoSettings(): JSX.Element {
    const client = useMatrixClientContext();
    const openTab = useContext(UserSettingsNavigationContext);
    const vm = useCreateAutoDisposedViewModel(() => new DesktopVoiceVideoSettingsViewModel({ client, openTab }));
    return <DesktopVoiceVideoSettingsView vm={vm} />;
}
