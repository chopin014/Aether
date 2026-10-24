/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { DesktopFullProfileView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type MatrixClient, type Room, type RoomMember, type User } from "matrix-js-sdk/src/matrix";

import BaseDialog from "../dialogs/BaseDialog";
import { _t } from "../../../languageHandler";
import type RightPanelStore from "../../../stores/right-panel/RightPanelStore";
import { DesktopProfileViewModel } from "../../../viewmodels/profile/DesktopProfileViewModel";

/** Modals render outside the app's React tree, so the host passes in what would normally come from context. */
interface Props {
    client: MatrixClient;
    rightPanelStore: RightPanelStore;
    member: RoomMember | User;
    room?: Room;
    roleSpace?: Room | null;
    isRoomViewed: boolean;
    onFinished(this: void): void;
}

/** The large Discord-style profile, hosted in Element's modal manager for its focus trap and Escape handling. */
export function DesktopFullProfileDialog({
    client,
    rightPanelStore,
    member,
    room,
    roleSpace,
    isRoomViewed,
    onFinished,
}: Props): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new DesktopProfileViewModel({
                client,
                member,
                room,
                roleSpace,
                isRoomViewed,
                rightPanelStore,
                full: true,
                onClose: onFinished,
                onOpenFull: onFinished,
            }),
    );
    return (
        <BaseDialog
            className="mx_DesktopFullProfileDialog"
            fixedWidth={false}
            hasCancel
            onFinished={onFinished}
            aria-label={_t("common|profile")}
        >
            <DesktopFullProfileView vm={vm} />
        </BaseDialog>
    );
}
