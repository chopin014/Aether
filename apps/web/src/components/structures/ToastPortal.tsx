/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Children and screen reader visibility for the global toast layer. */
interface Props {
    "children": ReactNode;
    "aria-hidden"?: boolean;
}

/** Renders both toast stacks above persisted calls and widgets, below dialogs and menus. */
export function ToastPortal({ children, "aria-hidden": ariaHidden }: Props): React.ReactPortal {
    let container = document.getElementById("mx_Toast_Container");
    if (!container) {
        // index.html supplies the host in production. Preserve its ordering in other entry points too.
        container = document.createElement("div");
        container.id = "mx_Toast_Container";
        const nextLayer = document.querySelector(
            "#mx_Dialog_StaticContainer, #mx_Dialog_Container, #mx_ContextualMenu_Container",
        );
        document.body.insertBefore(container, nextLayer);
    }

    return createPortal(<div aria-hidden={ariaHidden}>{children}</div>, container);
}
