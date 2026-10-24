/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createTestClient } from "test-utils";
import {
    RoomEvent,
    RoomStateEvent,
    EventType,
    MatrixEvent,
    MatrixEventEvent,
    Room,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";

import { PinnedMessagesViewModel } from "./PinnedMessagesViewModel";
import { fetchPinnedEvent } from "../../hooks/usePinnedEvents";
import PinningUtils from "../../utils/PinningUtils";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

vi.mock("../../hooks/usePinnedEvents", () => ({ fetchPinnedEvent: vi.fn() }));

describe("PinnedMessagesViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    let vm: PinnedMessagesViewModel;
    const onClose = vi.fn();
    const event = (id: string, ts = 1000): MatrixEvent =>
        new MatrixEvent({
            event_id: id,
            room_id: "!room:example.org",
            sender: "@alice:example.org",
            type: EventType.RoomMessage,
            origin_server_ts: ts,
            content: { body: id, msgtype: "m.text" },
        });
    const setPins = (ids: unknown): void =>
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomPinnedEvents,
                state_key: "",
                room_id: room.roomId,
                content: { pinned: ids },
            }),
        ]);
    const create = (): PinnedMessagesViewModel => (vm = new PinnedMessagesViewModel({ client, room, onClose }));
    const loaded = async (): Promise<void> => {
        await vi.waitFor(() => expect(vm.getSnapshot().loading).toBe(false));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        client = createTestClient();
        room = new Room("!room:example.org", client, "@alice:example.org");
        vi.mocked(client.getRoom).mockReturnValue(room);
        vi.mocked(client.setRoomAccountData).mockResolvedValue({});
        vi.spyOn(room.currentState, "mayClientSendStateEvent").mockReturnValue(true);
        vi.mocked(fetchPinnedEvent).mockImplementation(async (_room, id) => event(id));
    });
    afterEach(() => vm?.dispose());

    it("loads newest first, marks read, jumps through RoomView and closes", async () => {
        setPins(["$old", "$new"]);
        vi.mocked(fetchPinnedEvent).mockImplementation(async (_room, id) => event(id, id === "$new" ? 2000 : 1000));
        const dispatch = vi.spyOn(dis, "dispatch");
        create();
        expect(vm.getSnapshot().loading).toBe(true);
        await loaded();
        expect(vm.getSnapshot().items.map((item) => item.id)).toEqual(["$new", "$old"]);
        expect(vm.getSnapshot().items[0]).toMatchObject({ canUnpin: true, unavailable: false });
        expect(client.setRoomAccountData).toHaveBeenCalled();
        vm.jump("$new");
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, event_id: "$new", highlighted: true }),
        );
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("settles failed and partial fetches as unavailable and retries", async () => {
        setPins(["$one", "$unavailable"]);
        vi.mocked(fetchPinnedEvent).mockImplementation(async (_room, id) => (id === "$one" ? event(id) : null));
        create();
        await loaded();
        expect(vm.getSnapshot().error).toBe("load");
        expect(vm.getSnapshot().items.find((item) => item.id === "$unavailable")).toMatchObject({
            unavailable: true,
            canUnpin: true,
        });
        vi.mocked(fetchPinnedEvent).mockImplementation(async (_room, id) => event(id));
        vm.retry();
        await loaded();
        expect(vm.getSnapshot().error).toBeNull();
    });

    it("finishes an entirely rejected fetch and supports empty or malformed pins", async () => {
        setPins(["$one"]);
        vi.mocked(fetchPinnedEvent).mockRejectedValue(new Error("offline"));
        create();
        await loaded();
        expect(vm.getSnapshot().error).toBe("load");
        setPins("invalid");
        await loaded();
        expect(vm.getSnapshot()).toEqual({ items: [], loading: false, error: null });
    });

    it("updates permissions and pin state while open and ignores an obsolete request", async () => {
        setPins(["$old"]);
        let resolveOld!: (event: MatrixEvent) => void;
        vi.mocked(fetchPinnedEvent).mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)));
        create();
        setPins(["$new"]);
        await loaded();
        resolveOld(event("$old"));
        await Promise.resolve();
        expect(vm.getSnapshot().items.map((item) => item.id)).toEqual(["$new"]);
        vi.spyOn(room.currentState, "mayClientSendStateEvent").mockReturnValue(false);
        room.currentState.setStateEvents([
            new MatrixEvent({ type: EventType.RoomPowerLevels, state_key: "", room_id: room.roomId, content: {} }),
        ]);
        expect(vm.getSnapshot().items[0].canUnpin).toBe(false);
    });

    it("retains an unpin error with retry and prevents duplicate requests", async () => {
        setPins(["$one"]);
        create();
        await loaded();
        const unpin = vi
            .spyOn(PinningUtils, "unpinEvent")
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue(undefined);
        vm.unpin("$one");
        vm.unpin("$one");
        await vi.waitFor(() => expect(vm.getSnapshot().error).toBe("unpin"));
        expect(unpin).toHaveBeenCalledOnce();
        vm.retry();
        await vi.waitFor(() => expect(unpin).toHaveBeenCalledTimes(2));
        expect(vm.getSnapshot().error).toBeNull();
    });

    it("applies edits and redactions to fetched copies while open", async () => {
        setPins(["$one"]);
        create();
        await loaded();
        const edit = event("$edit", 2000);
        edit.event.content = {
            "body": "* edited",
            "msgtype": "m.text",
            "m.new_content": { body: "edited", msgtype: "m.text" },
            "m.relates_to": { rel_type: "m.replace", event_id: "$one" },
        };
        await room.addLiveEvents([edit], { addToState: false });
        expect(vm.getEvent("$one")?.getContent().body).toBe("edited");
        const redaction = new MatrixEvent({
            event_id: "$redaction",
            room_id: room.roomId,
            sender: "@alice:example.org",
            type: EventType.RoomRedaction,
            redacts: "$one",
            content: {},
        });
        room.emit(RoomEvent.Redaction, redaction, room);
        expect(vm.getEvent("$one")?.isRedacted()).toBe(true);
    });

    it("keeps edits arriving during loading and rejects edits from other senders or older edits", async () => {
        setPins(["$one"]);
        let resolve!: (event: MatrixEvent) => void;
        vi.mocked(fetchPinnedEvent).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
        create();
        const edit = event("$new-edit", 3000);
        edit.event.content = {
            "body": "* newest",
            "msgtype": "m.text",
            "m.new_content": { body: "newest", msgtype: "m.text" },
            "m.relates_to": { rel_type: "m.replace", event_id: "$one" },
        };
        await room.addLiveEvents([edit], { addToState: false });
        resolve(event("$one"));
        await loaded();
        expect(vm.getEvent("$one")?.getContent().body).toBe("newest");
        const attacker = new MatrixEvent({
            ...edit.event,
            sender: "@mallory:example.org",
            event_id: "$forged",
            origin_server_ts: 4000,
        });
        const older = new MatrixEvent({ ...edit.event, event_id: "$older", origin_server_ts: 2000 });
        await room.addLiveEvents([attacker, older], { addToState: false });
        expect(vm.getEvent("$one")?.replacingEvent()?.getId()).toBe("$new-edit");
    });

    it("does not publish a pending response after disposal", async () => {
        setPins(["$one"]);
        let resolve!: (event: MatrixEvent) => void;
        vi.mocked(fetchPinnedEvent).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
        create();
        const listener = vi.fn();
        vm.subscribe(listener);
        vm.dispose();
        resolve(event("$one"));
        await Promise.resolve();
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
    });

    it("cleans up event listeners and ignores requests completing after disposal", async () => {
        setPins(["$one"]);
        create();
        await loaded();
        const ev = vm.getEvent("$one")!;
        expect(ev.listenerCount(MatrixEventEvent.Replaced)).toBe(1);
        const stateListeners = room.currentState.listenerCount(RoomStateEvent.Update);
        vm.dispose();
        expect(ev.listenerCount(MatrixEventEvent.Replaced)).toBe(0);
        expect(room.currentState.listenerCount(RoomStateEvent.Update)).toBe(stateListeners - 1);
    });
});
