/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useContext } from "react";
import { DesktopTitlebarView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { SDKContext } from "../../contexts/SDKContext";
import { RoomListHeaderViewModel } from "../../viewmodels/room-list/RoomListHeaderViewModel";

/** Reuse the existing Space selection and live room-name subscriptions. */
export function DesktopTitlebarContainer(): JSX.Element {
    const { client, spaceStore } = useContext(SDKContext);
    const vm = useCreateAutoDisposedViewModel(() => new RoomListHeaderViewModel({ matrixClient: client!, spaceStore }));
    return <DesktopTitlebarView vm={vm} />;
}
