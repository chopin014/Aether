/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { DesktopKeybindsView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { DesktopKeybindsViewModel } from "../../../../../viewmodels/settings/DesktopKeybindsViewModel";

/** Owns shortcut settings recording for the lifetime of the Keyboard settings tab. */
export function DesktopKeybindsSettings(): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new DesktopKeybindsViewModel());
    return <DesktopKeybindsView vm={vm} />;
}
