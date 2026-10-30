/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { DeleteServerView, useCreateAutoDisposedViewModel, useViewModel } from "@element-hq/web-shared-components";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import BaseDialog from "./BaseDialog";
import { DeleteServerViewModel } from "../../../viewmodels/desktop/DeleteServerViewModel";
import { _t } from "../../../languageHandler";

/** The server to delete and the dialog completion callback. */
interface Props {
    client: MatrixClient;
    space: Room;
    onFinished: () => void;
}

/** Hosts the server deletion confirmation throughout navigation and sync. */
export function DeleteServerDialog(props: Props): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new DeleteServerViewModel(props));
    const { busy } = useViewModel(vm);
    return (
        <BaseDialog
            title={_t("desktop|delete_server|title")}
            aria-label={_t("desktop|delete_server|title")}
            onFinished={vm.cancel}
            hasCancel={!busy}
        >
            <DeleteServerView vm={vm} />
        </BaseDialog>
    );
}
