/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { CreateServerView, useCreateAutoDisposedViewModel, useViewModel } from "@element-hq/web-shared-components";

import BaseDialog from "./BaseDialog";
import { CreateServerViewModel } from "../../../viewmodels/desktop/CreateServerViewModel";
import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { useSettingValue } from "../../../hooks/useSettings";
import { UIFeature } from "../../../settings/UIFeature";
import { _t } from "../../../languageHandler";

/** Props for {@link CreateServerDialog}. */
interface CreateServerDialogProps {
    onFinished: () => void;
}

/** Hosts the Discord-style flow for creating or joining a server, and stays open while a server is created. */
export function CreateServerDialog({ onFinished }: CreateServerDialogProps): JSX.Element {
    const client = useMatrixClientContext();
    const allowPublic = useSettingValue(UIFeature.AllowCreatingPublicSpaces);
    const vm = useCreateAutoDisposedViewModel(
        () => new CreateServerViewModel({ client, onFinished, canChooseAudience: allowPublic !== false }),
    );
    const { busy } = useViewModel(vm);
    return (
        <BaseDialog
            className="mx_CreateServerDialog"
            aria-label={_t("create_space|label")}
            onFinished={busy ? undefined : onFinished}
            hasCancel={!busy}
        >
            <CreateServerView vm={vm} />
        </BaseDialog>
    );
}
