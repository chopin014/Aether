/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type ServerNicknameDialogViewModel as ServerNicknameDialogViewModelInterface,
    type ServerNicknameDialogViewSnapshot,
} from "@element-hq/web-shared-components";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { currentNickname, moderatorNickname, setNickname } from "../../utils/serverNickname";

/** The person and server a nickname dialog is about. */
export interface ServerNicknameDialogViewModelProps {
    client: MatrixClient;
    /** The server (Space) the nickname applies in. */
    server: Room;
    /** Whose nickname: the user's own, or someone a moderator renames. */
    userId: string;
    /** Closes the dialog. */
    onFinished: () => void;
}

/**
 * Changes a nickname in one server: the user's own, which their Aether writes into their memberships, or, for a
 * moderator, someone else's, recorded in the server for that person's Aether to carry out.
 */
export class ServerNicknameDialogViewModel
    extends BaseViewModel<ServerNicknameDialogViewSnapshot, ServerNicknameDialogViewModelProps>
    implements ServerNicknameDialogViewModelInterface
{
    public constructor(props: ServerNicknameDialogViewModelProps) {
        const { client, server, userId } = props;
        const forSelf = userId === client.getSafeUserId();
        const nickname = currentNickname(client, server, userId);
        super(props, {
            forSelf,
            personName: client.getUser(userId)?.displayName || server.getMember(userId)?.name || userId,
            nickname,
            canReset: nickname !== "",
            setByModerator: forSelf && moderatorNickname(server, userId) !== undefined,
            busy: false,
        });
    }

    public setNickname = (nickname: string): void => {
        this.snapshot.merge({ nickname, error: undefined });
    };

    public save = (): void => {
        void this.apply(this.snapshot.current.nickname);
    };

    public reset = (): void => {
        void this.apply("");
    };

    public cancel = (): void => {
        this.props.onFinished();
    };

    private async apply(nickname: string): Promise<void> {
        const { client, server, userId, onFinished } = this.props;
        this.snapshot.merge({ busy: true, error: undefined });
        try {
            await setNickname(client, server, userId, nickname);
            onFinished();
        } catch (error) {
            logger.warn("Could not change the nickname", error);
            if (!this.isDisposed) {
                this.snapshot.merge({ busy: false, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }
}
