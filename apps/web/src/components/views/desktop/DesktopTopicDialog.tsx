/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { TopicDialogView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import BaseDialog from "../dialogs/BaseDialog";
import { TopicDialogViewModel } from "../../../viewmodels/desktop/TopicDialogViewModel";

interface Props {
    room: Room;
    onFinished(this: void): void;
}

/** The full channel topic, hosted in Element's modal manager for its focus trap and Escape handling. */
export function DesktopTopicDialog({ room, onFinished }: Props): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new TopicDialogViewModel({ room, onFinished }));
    return (
        <BaseDialog
            className="mx_DesktopTopicDialog"
            fixedWidth={false}
            hasCancel
            onFinished={onFinished}
            aria-label={room.name}
        >
            <TopicDialogView vm={vm} />
        </BaseDialog>
    );
}
