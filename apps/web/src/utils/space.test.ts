/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type Room, RoomType } from "matrix-js-sdk/src/matrix";
import { createTestClient, mkSpace } from "test-utils";

import Modal from "../Modal";
import * as createRoomModule from "../createRoom";
import { showCreateNewRoom } from "./space";

describe("showCreateNewRoom", () => {
    let space: Room;
    let createDialog: ReturnType<typeof vi.spyOn>;

    function finishDialog(result: [boolean, object?]): void {
        createDialog.mockReturnValue({ finished: Promise.resolve(result), close: vi.fn() } as never);
    }

    beforeEach(() => {
        const client = createTestClient();
        space = mkSpace(client, "!space:server") as unknown as Room;
        vi.mocked(client.setRoomTag).mockResolvedValue({});
        createDialog = vi.spyOn(Modal, "createDialog");
        vi.spyOn(createRoomModule, "default").mockResolvedValue("!new:server");
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("names the section in the dialog and files the new room into it", async () => {
        finishDialog([true, { name: "Geral#3" }]);
        await expect(
            showCreateNewRoom(space, RoomType.UnstableCall, {
                sectionTag: "element.io.section.voz",
                sectionName: "Voz",
            }),
        ).resolves.toBe(true);
        expect(createDialog).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: RoomType.UnstableCall, parentSpace: space, sectionName: "Voz" }),
        );
        expect(space.client.setRoomTag).toHaveBeenCalledWith("!new:server", "element.io.section.voz", {});
    });

    it("leaves the new room untagged without a section", async () => {
        finishDialog([true, { name: "geral" }]);
        await showCreateNewRoom(space);
        expect(createRoomModule.default).toHaveBeenCalled();
        expect(space.client.setRoomTag).not.toHaveBeenCalled();
    });

    it("keeps the created room when filing it fails", async () => {
        vi.mocked(space.client.setRoomTag).mockRejectedValue(new Error("offline"));
        finishDialog([true, { name: "geral" }]);
        await expect(showCreateNewRoom(space, undefined, { sectionTag: "m.favourite" })).resolves.toBe(true);
    });

    it("creates nothing when the dialog is cancelled", async () => {
        finishDialog([false]);
        await expect(showCreateNewRoom(space, undefined, { sectionTag: "m.favourite" })).resolves.toBe(false);
        expect(createRoomModule.default).not.toHaveBeenCalled();
        expect(space.client.setRoomTag).not.toHaveBeenCalled();
    });
});
