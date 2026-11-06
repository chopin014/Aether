/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import Modal from "../../Modal";
import { PromoteToPeerDialog } from "../../components/views/dialogs/PromoteToPeerDialog";
import { confirmPeerPromotion } from "./confirmPeerPromotion";

vi.mock("../../Modal", () => ({ default: { createDialog: vi.fn() } }));

const ME = "@me:example.org";
const BOB = "@bob:example.org";

describe("confirmPeerPromotion", () => {
    const client = { getUserId: () => ME } as unknown as MatrixClient;
    let myLevel: number | undefined;
    const room = {
        getMember: (userId: string) =>
            userId === ME && myLevel !== undefined ? ({ powerLevel: myLevel } as RoomMember) : null,
    } as unknown as Room;

    beforeEach(() => {
        myLevel = 100;
        vi.mocked(Modal.createDialog).mockReset();
    });

    it("lets a promotion below the user's own level through without asking", async () => {
        await expect(confirmPeerPromotion(client, room, [BOB], 50)).resolves.toBe(true);
        expect(Modal.createDialog).not.toHaveBeenCalled();
    });

    it("does not ask about the user's own level or when the user's level is unknown", async () => {
        await expect(confirmPeerPromotion(client, room, [ME], 100)).resolves.toBe(true);
        myLevel = undefined;
        await expect(confirmPeerPromotion(client, room, [BOB], 100)).resolves.toBe(true);
        expect(Modal.createDialog).not.toHaveBeenCalled();
    });

    it("asks for a typed confirmation when someone would reach the user's level", async () => {
        vi.mocked(Modal.createDialog).mockReturnValue({ finished: Promise.resolve([true]) } as never);
        await expect(confirmPeerPromotion(client, room, [ME, BOB], 100)).resolves.toBe(true);
        expect(Modal.createDialog).toHaveBeenCalledWith(PromoteToPeerDialog, { room, userIds: [BOB] });
    });

    it("refuses when the confirmation is dismissed", async () => {
        vi.mocked(Modal.createDialog).mockReturnValue({ finished: Promise.resolve([]) } as never);
        await expect(confirmPeerPromotion(client, room, [BOB], 100)).resolves.toBe(false);
    });
});
