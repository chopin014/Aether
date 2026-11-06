/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect } from "react";
import { createPortal } from "react-dom";
import { IncomingCallView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { IncomingCallViewModel } from "../../../viewmodels/desktop/IncomingCallViewModel";

/**
 * Shows the desktop shell's incoming call popup and plays the ring. The popup is attached to the document body so
 * it stays above dialogs and every other part of the app.
 */
export function DesktopIncomingCallHost(): JSX.Element {
    const client = useMatrixClientContext();
    const vm = useCreateAutoDisposedViewModel(() => new IncomingCallViewModel({ client }));
    useEffect(() => vm.startRingtone(), [vm]);
    return createPortal(<IncomingCallView vm={vm} />, document.body);
}
