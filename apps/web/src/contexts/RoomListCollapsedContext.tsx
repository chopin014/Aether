/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { createContext, type PropsWithChildren, type JSX } from "react";
import { useViewModel, type ViewModel, type ResizerViewSnapshot } from "@element-hq/web-shared-components";

/** Tracks the live resizer state, including automatic collapse during calls. */
export const RoomListCollapsedContext = createContext(false);

/** Keep account actions outside a collapsed, inert room sidebar. */
export function RoomListCollapsedProvider({
    vm,
    children,
}: PropsWithChildren<{ vm: ViewModel<ResizerViewSnapshot> }>): JSX.Element {
    const { isCollapsed } = useViewModel(vm);
    return <RoomListCollapsedContext.Provider value={isCollapsed}>{children}</RoomListCollapsedContext.Provider>;
}
