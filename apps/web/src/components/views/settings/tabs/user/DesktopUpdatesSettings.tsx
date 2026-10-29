/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { DesktopUpdatesView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { DesktopUpdatesViewModel } from "../../../../../viewmodels/settings/DesktopUpdatesViewModel";

/** Owns the update page model for the lifetime of the settings tab. */
export function DesktopUpdatesSettings(): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new DesktopUpdatesViewModel());
    return <DesktopUpdatesView vm={vm} />;
}
