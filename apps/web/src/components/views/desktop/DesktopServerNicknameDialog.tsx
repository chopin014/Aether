/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { ServerNicknameDialogView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import BaseDialog from "../dialogs/BaseDialog";
import Modal from "../../../Modal";
import { ServerNicknameDialogViewModel } from "../../../viewmodels/desktop/ServerNicknameDialogViewModel";
import { _t } from "../../../languageHandler";

interface Props {
    client: MatrixClient;
    server: Room;
    userId: string;
    onFinished(this: void): void;
}

/** Change a nickname in a server, hosted in Element's modal manager for its focus trap and Escape handling. */
export function DesktopServerNicknameDialog({ client, server, userId, onFinished }: Props): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(
        () => new ServerNicknameDialogViewModel({ client, server, userId, onFinished }),
    );
    return (
        <BaseDialog
            className="mx_DesktopServerNicknameDialog"
            fixedWidth={false}
            hasCancel
            onFinished={onFinished}
            aria-label={_t("desktop|nickname|change")}
        >
            <ServerNicknameDialogView vm={vm} />
        </BaseDialog>
    );
}

/** Opens the dialog that changes `userId`'s nickname in `server`. */
export function showServerNicknameDialog(client: MatrixClient, server: Room, userId: string): void {
    Modal.createDialog(DesktopServerNicknameDialog, { client, server, userId });
}
