/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import {
    ChooseServerChannelsView,
    useCreateAutoDisposedViewModel,
    useViewModel,
} from "@element-hq/web-shared-components";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import BaseDialog from "./BaseDialog";
import { ChooseServerChannelsViewModel } from "../../../viewmodels/desktop/ChooseServerChannelsViewModel";
import { type ServerChannel } from "../../../utils/servers/serverChannels";
import { defaultChannelSelection, openFirstChannel } from "../../../utils/servers/joinServer";
import { _t } from "../../../languageHandler";

/** Props for {@link ChooseServerChannelsDialog}. */
interface ChooseServerChannelsDialogProps {
    client: MatrixClient;
    /** The server that was just joined. */
    space: Room;
    /** Its channels the user has not joined. */
    channels: ServerChannel[];
    onFinished: () => void;
}

/** Hosts the channel picker shown after joining a server with many channels. */
export function ChooseServerChannelsDialog({
    client,
    space,
    channels,
    onFinished,
}: ChooseServerChannelsDialogProps): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new ChooseServerChannelsViewModel({
                client,
                space,
                channels,
                initialSelection: defaultChannelSelection(channels),
                onFinished,
                openFirstChannel,
            }),
    );
    const { busy } = useViewModel(vm);
    return (
        <BaseDialog
            aria-label={_t("desktop|choose_channels|title")}
            onFinished={busy ? undefined : onFinished}
            hasCancel={!busy}
        >
            <ChooseServerChannelsView vm={vm} />
        </BaseDialog>
    );
}
