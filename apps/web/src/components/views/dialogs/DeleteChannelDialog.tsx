/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { DeleteChannelView, useCreateAutoDisposedViewModel, useViewModel } from "@element-hq/web-shared-components";
import { type Room, type MatrixClient } from "matrix-js-sdk/src/matrix";

import BaseDialog from "./BaseDialog";
import { DeleteChannelViewModel } from "../../../viewmodels/desktop/DeleteChannelViewModel";
import { _t } from "../../../languageHandler";

/** Props for the channel deletion confirmation. */
interface DeleteChannelDialogProps {
    room: Room;
    space: Room;
    client: MatrixClient;
    onFinished: () => void;
}

/** Hosts the deletion confirmation and keeps it open while mutations are running. */
export function DeleteChannelDialog(props: DeleteChannelDialogProps): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new DeleteChannelViewModel(props));
    const { busy } = useViewModel(vm);
    return (
        <BaseDialog title={_t("desktop|delete_channel|title")} onFinished={vm.cancel} hasCancel={!busy}>
            <DeleteChannelView vm={vm} />
        </BaseDialog>
    );
}
