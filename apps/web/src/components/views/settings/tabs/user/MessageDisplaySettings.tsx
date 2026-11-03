/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { MessageDisplayView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { MessageDisplayViewModel } from "../../../../../viewmodels/settings/MessageDisplayViewModel";

/** Owns the message display model for the lifetime of the settings tab. */
export function MessageDisplaySettings(): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new MessageDisplayViewModel());
    return <MessageDisplayView vm={vm} />;
}
