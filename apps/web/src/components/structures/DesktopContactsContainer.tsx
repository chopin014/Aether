/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useContext } from "react";
import {
    DesktopContactsView,
    DesktopHomeNavigationView,
    useCreateAutoDisposedViewModel,
} from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../../contexts/MatrixClientContext";
import { SDKContext } from "../../contexts/SDKContext";
import { DesktopContactsViewModel } from "../../viewmodels/desktop/DesktopContactsViewModel";

/** Owns and disposes the Matrix-backed contacts model for either Home surface. */
export function DesktopContactsContainer({ navigation = false }: { navigation?: boolean }): JSX.Element {
    const client = useMatrixClientContext();
    const { spaceStore } = useContext(SDKContext);
    const vm = useCreateAutoDisposedViewModel(() => new DesktopContactsViewModel({ client, spaceStore }));
    return navigation ? <DesktopHomeNavigationView vm={vm} /> : <DesktopContactsView vm={vm} />;
}
