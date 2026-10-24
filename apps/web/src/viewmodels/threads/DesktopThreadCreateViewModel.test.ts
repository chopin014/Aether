/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventStatus, MsgType, PendingEventOrdering, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { mkMessage, stubClient } from "test-utils";

import { DesktopThreadCreateViewModel } from "./DesktopThreadCreateViewModel";

describe("DesktopThreadCreateViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    const createVm = (otherRoom = room) =>
        new DesktopThreadCreateViewModel({ client, room: otherRoom, onCreated, onCancel });
    beforeEach(() => {
        client = stubClient();
        room = new Room("!create:example.org", client, client.getSafeUserId(), {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        vi.spyOn(room, "getMyMembership").mockReturnValue("join");
        vi.spyOn(room.currentState, "maySendEvent").mockReturnValue(true);
        vi.mocked(client.makeTxnId).mockReturnValueOnce("starter-txn").mockReturnValueOnce("reply-txn");
        onCreated.mockClear();
        onCancel.mockClear();
        const root = mkMessage({ user: client.getSafeUserId(), room: room.roomId, event: true, msg: "Starter" });
        vi.spyOn(room, "findEventById").mockReturnValue(root);
        vi.mocked(client.sendMessage)
            .mockResolvedValueOnce({ event_id: "$starter" })
            .mockResolvedValue({ event_id: "$reply" });
    });
    function fill(vm: DesktopThreadCreateViewModel) {
        vm.setStarter("Starter");
        vm.setReply("First reply");
    }
    it("sends nothing when opened or cancelled and keeps a room-specific session draft", () => {
        const vm = createVm();
        fill(vm);
        vm.cancel();
        vm.dispose();
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(onCancel).toHaveBeenCalledOnce();
        expect(createVm().getSnapshot()).toMatchObject({ starter: "Starter", reply: "First reply" });
        const otherRoom = new Room("!other:example.org", client, client.getSafeUserId());
        expect(createVm(otherRoom).getSnapshot()).toMatchObject({ starter: "", reply: "" });
    });
    it("uses the SDK room and thread send pipelines, then clears only the completed draft", async () => {
        const vm = createVm();
        fill(vm);
        await vm.submit();
        expect(client.sendMessage).toHaveBeenNthCalledWith(
            1,
            room.roomId,
            null,
            { msgtype: MsgType.Text, body: "Starter" },
            "starter-txn",
        );
        expect(client.sendMessage).toHaveBeenNthCalledWith(
            2,
            room.roomId,
            "$starter",
            { msgtype: MsgType.Text, body: "First reply" },
            "reply-txn",
        );
        expect(onCreated).toHaveBeenCalledWith(room.findEventById("$starter"));
        expect(createVm().getSnapshot().starter).toBe("");
    });
    it("keeps a successful root and retries only the failed reply with the same transaction", async () => {
        const vm = createVm();
        fill(vm);
        vi.mocked(client.sendMessage)
            .mockReset()
            .mockResolvedValueOnce({ event_id: "$starter" })
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ event_id: "$reply" });
        await vm.submit();
        expect(vm.getSnapshot()).toMatchObject({
            error: true,
            starterSent: true,
            locked: true,
            sending: false,
            reply: "First reply",
        });
        vm.setStarter("Cannot replace a sent message");
        vm.setReply("Cannot replace an uncertain send");
        await vm.submit();
        expect(client.sendMessage).toHaveBeenCalledTimes(3);
        expect(client.sendMessage).toHaveBeenLastCalledWith(
            room.roomId,
            "$starter",
            { msgtype: MsgType.Text, body: "First reply" },
            "reply-txn",
        );
        expect(onCreated).toHaveBeenCalledOnce();
    });
    it("resends failed SDK local echoes instead of adding a second root", async () => {
        const vm = createVm();
        fill(vm);
        vi.mocked(client.sendMessage)
            .mockReset()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue({ event_id: "$reply" });
        await vm.submit();
        const pending = mkMessage({ user: client.getSafeUserId(), room: room.roomId, event: true, msg: "Starter" });
        pending.setTxnId("starter-txn");
        pending.setStatus(EventStatus.NOT_SENT);
        vi.spyOn(room, "getPendingEvents").mockReturnValue([pending]);
        vi.mocked(client.resendEvent).mockResolvedValue({ event_id: "$starter" });
        await vm.submit();
        expect(client.resendEvent).toHaveBeenCalledWith(pending, room);
        expect(client.sendMessage).toHaveBeenCalledTimes(2);
    });
    it("blocks simultaneous submits and never navigates to a disposed room", async () => {
        const vm = createVm();
        fill(vm);
        let finish!: (result: { event_id: string }) => void;
        vi.mocked(client.sendMessage)
            .mockReset()
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    finish = resolve;
                }),
            )
            .mockResolvedValue({ event_id: "$reply" });
        const sending = vm.submit();
        await vm.submit();
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
        vm.cancel();
        expect(onCancel).not.toHaveBeenCalled();
        vm.dispose();
        finish({ event_id: "$starter" });
        await sending;
        expect(onCreated).not.toHaveBeenCalled();
    });
    it("updates a reopened form when a send started by its disposed predecessor finishes", async () => {
        const vm = createVm();
        fill(vm);
        let finish!: (result: { event_id: string }) => void;
        vi.mocked(client.sendMessage)
            .mockReset()
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    finish = resolve;
                }),
            )
            .mockRejectedValueOnce(new Error("reply failed"));
        const sending = vm.submit();
        vm.dispose();
        const reopened = createVm();
        expect(reopened.getSnapshot().sending).toBe(true);
        finish({ event_id: "$starter" });
        await sending;
        expect(reopened.getSnapshot()).toMatchObject({ sending: false, error: true, starterSent: true });
        vi.mocked(client.sendMessage).mockResolvedValue({ event_id: "$reply" });
        await reopened.submit();
        expect(onCreated).toHaveBeenCalledOnce();
        reopened.dispose();
    });

    it("rechecks send permissions at submission", async () => {
        const vm = createVm();
        fill(vm);
        vi.mocked(room.currentState.maySendEvent).mockReturnValue(false);
        await vm.submit();
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(vm.getSnapshot().error).toBe(true);
    });
});
