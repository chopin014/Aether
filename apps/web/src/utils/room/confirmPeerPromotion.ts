/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import Modal from "../../Modal";
import { PromoteToPeerDialog } from "../../components/views/dialogs/PromoteToPeerDialog";

/**
 * Ask before giving other people a power level at or above the user's own. Nobody can lower the level of someone at
 * their own level, so such a promotion cannot be undone and needs a typed confirmation.
 *
 * @returns whether the change may go ahead: true when no confirmation was needed or the user confirmed.
 */
export async function confirmPeerPromotion(
    client: MatrixClient,
    room: Room,
    userIds: string[],
    level: number,
): Promise<boolean> {
    const me = client.getUserId();
    const myLevel = me ? room.getMember(me)?.powerLevel : undefined;
    const peers = userIds.filter((userId) => userId !== me);
    if (myLevel === undefined || level < myLevel || peers.length === 0) return true;

    const { finished } = Modal.createDialog(PromoteToPeerDialog, { room, userIds: peers });
    const [confirmed] = await finished;
    return confirmed === true;
}
