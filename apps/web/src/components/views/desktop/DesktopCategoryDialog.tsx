/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { CategoryDialogView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import BaseDialog from "../dialogs/BaseDialog";
import { CategoryDialogViewModel } from "../../../viewmodels/desktop/CategoryDialogViewModel";
import { _t } from "../../../languageHandler";

interface Props {
    space: Room;
    categoryId?: string;
    currentName?: string;
    onFinished(this: void): void;
}

/** Create or rename a server category, hosted in Element's modal manager for its focus trap and Escape handling. */
export function DesktopCategoryDialog({ space, categoryId, currentName, onFinished }: Props): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(
        () => new CategoryDialogViewModel({ space, categoryId, currentName, onFinished }),
    );
    return (
        <BaseDialog
            className="mx_DesktopCategoryDialog"
            fixedWidth={false}
            hasCancel
            onFinished={onFinished}
            aria-label={categoryId ? _t("desktop|categories|edit") : _t("desktop|categories|create")}
        >
            <CategoryDialogView vm={vm} />
        </BaseDialog>
    );
}
