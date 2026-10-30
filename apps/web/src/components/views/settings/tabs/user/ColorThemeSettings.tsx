/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { ColorThemeView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { ColorThemeViewModel } from "../../../../../viewmodels/settings/ColorThemeViewModel";

/** Owns the colour theme model for the lifetime of the settings tab. */
export function ColorThemeSettings(): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new ColorThemeViewModel());
    return <ColorThemeView vm={vm} />;
}
