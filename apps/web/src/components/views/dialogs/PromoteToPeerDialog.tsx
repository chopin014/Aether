/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { PromoteToPeerView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import BaseDialog from "./BaseDialog";
import { PromoteToPeerViewModel } from "../../../viewmodels/desktop/PromoteToPeerViewModel";
import { _t } from "../../../languageHandler";

/** Props for {@link PromoteToPeerDialog}. */
interface PromoteToPeerDialogProps {
    /** The channel or server whose power levels change. */
    room: Room;
    /** Everyone who would reach the user's own power level. */
    userIds: string[];
    /** Called with whether the user confirmed. */
    onFinished: (confirmed?: boolean) => void;
}

/** Hosts the typed confirmation shown before people are given the user's own power level. */
export function PromoteToPeerDialog({ room, userIds, onFinished }: PromoteToPeerDialogProps): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new PromoteToPeerViewModel({ room, userIds, onFinished }));
    return (
        <BaseDialog title={_t("desktop|promote_peer|title")} onFinished={vm.cancel}>
            <PromoteToPeerView vm={vm} />
        </BaseDialog>
    );
}
