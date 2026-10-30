/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DeleteChannelViewSnapshot,
    type DeleteChannelViewActions,
} from "@element-hq/web-shared-components";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { RoomDeletion } from "../../utils/room/RoomDeletion";
import { _t } from "../../languageHandler";

interface Props {
    room: Room;
    space: Room;
    client: MatrixClient;
    onFinished: () => void;
}

/** Closes a channel with standard Matrix operations, leaving after member removal and unlinking succeed. */
export class DeleteChannelViewModel
    extends BaseViewModel<DeleteChannelViewSnapshot, Props>
    implements DeleteChannelViewActions
{
    private readonly deletion: RoomDeletion;

    public constructor(props: Props) {
        super(props, { name: props.room.name, busy: false, left: false });
        this.deletion = this.disposables.track(
            new RoomDeletion(
                props.client,
                props.room,
                [props.space],
                (progress) => this.snapshot.merge({ progress, left: this.deletion.left }),
                _t("desktop|delete_channel|reason"),
            ),
        );
    }

    public cancel = (): void => {
        if (!this.getSnapshot().busy) this.props.onFinished();
    };

    public confirm = async (): Promise<void> => {
        if (this.getSnapshot().busy) return;
        this.snapshot.merge({ busy: true, error: undefined, progress: _t("desktop|delete_channel|checking") });
        try {
            await this.deletion.prepare();
            await this.deletion.removeMembers();
            await this.deletion.unlink();
            await this.deletion.finish();
            this.props.onFinished();
        } catch (error) {
            logger.warn("Channel deletion interrupted", error);
            this.snapshot.merge({
                error: this.deletion.left
                    ? _t("desktop|delete_channel|forget_error")
                    : _t("desktop|delete_channel|error"),
            });
        } finally {
            this.snapshot.merge({ busy: false, left: this.deletion.left });
        }
    };
}
