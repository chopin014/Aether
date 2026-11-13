/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { afterEach, describe, it, expect, beforeEach, vi, type MockedObject } from "vitest";
import {
    type IEvent,
    type IStateEventWithRoomId,
    type MatrixEvent,
    Room,
    PendingEventOrdering,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { act, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { stubClient, mkEvent, makeRoomWithStateEvents } from "test-utils";

import { RoomStateExplorer } from "./RoomState";
import MatrixClientContext from "../../../../contexts/MatrixClientContext";
import { DevtoolsContext } from "./BaseTool";
import { SlidingSyncManager } from "../../../../SlidingSyncManager";

describe("<RoomStateExplorer />", () => {
    const roomId = "!roomId:example.com";
    const userId = "@alice:example.com";
    let cli: MockedObject<MatrixClient>;

    const nameEvent = (): MatrixEvent =>
        mkEvent({ event: true, type: "m.room.name", content: { name: "Test room" }, room: roomId, user: userId });

    beforeEach(() => {
        cli = stubClient() as MockedObject<MatrixClient>;
    });

    function explorer(room: Room): React.JSX.Element {
        return (
            <MatrixClientContext.Provider value={cli}>
                <DevtoolsContext.Provider value={{ room }}>
                    <RoomStateExplorer onBack={() => {}} setTool={() => {}} />
                </DevtoolsContext.Provider>
            </MatrixClientContext.Provider>
        );
    }

    function renderComponent(room: Room): ReturnType<typeof render> {
        return render(explorer(room));
    }

    it("should render", () => {
        const room = new Room(roomId, cli, userId, {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });

        const { asFragment } = renderComponent(room);
        expect(asFragment()).toMatchSnapshot();
    });

    it("shows real room state and can check a single event", async () => {
        const nameEvent = mkEvent({
            event: true,
            type: "m.room.name",
            content: { name: "Test room" },
            room: roomId,
            user: userId,
        });
        const room = makeRoomWithStateEvents([nameEvent], { roomId, mockClient: cli });

        renderComponent(room);

        await userEvent.click(screen.getByRole("button", { name: "m.room.name" }));

        expect(screen.getByText(/Test room/)).toBeInTheDocument();
    });

    it("shows the history of a state event", async () => {
        const previousEvent = mkEvent({
            event: false,
            type: "m.room.topic",
            content: { topic: "Old topic" },
            room: roomId,
            user: userId,
            id: "$prevEventId",
        });
        const currentEvent = mkEvent({
            event: true,
            type: "m.room.topic",
            content: { topic: "New topic" },
            room: roomId,
            user: userId,
            id: "$currentEventId",
            unsigned: { replaces_state: "$prevEventId" },
        });
        vi.mocked(cli.fetchRoomEvent).mockResolvedValueOnce(previousEvent as unknown as IEvent);

        const room = makeRoomWithStateEvents([currentEvent], { roomId, mockClient: cli });

        renderComponent(room);

        await userEvent.click(screen.getByRole("button", { name: "m.room.topic" }));
        expect(screen.getByText(/New topic/)).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "See history" }));

        await waitFor(() => expect(screen.getByText(/Old topic/)).toBeInTheDocument());
        expect(screen.getByText(/New topic/)).toBeInTheDocument();
    });

    it("shows the state this device has, without asking the server, under regular sync", async () => {
        cli.roomState = vi.fn();
        const room = makeRoomWithStateEvents([nameEvent()], { roomId, mockClient: cli });

        renderComponent(room);

        expect(screen.getByRole("button", { name: "m.room.name" })).toBeInTheDocument();
        expect(cli.roomState).not.toHaveBeenCalled();
    });

    describe("under sliding sync", () => {
        // Sliding sync loads only the state the app reads.
        beforeEach(() => {
            vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(true);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        const stateEvent = (type: string, stateKey: string, id: string, content = {}): IStateEventWithRoomId => ({
            type,
            state_key: stateKey,
            content,
            event_id: id,
            sender: userId,
            room_id: roomId,
            origin_server_ts: 0,
            unsigned: {},
        });

        it("shows all of the room's state, fetched from the server", async () => {
            const fetched = Promise.withResolvers<IStateEventWithRoomId[]>();
            cli.roomState = vi.fn().mockReturnValue(fetched.promise);
            const room = makeRoomWithStateEvents([nameEvent()], { roomId, mockClient: cli });

            renderComponent(room);
            // Nothing is listed until the server answers.
            expect(screen.queryByRole("button", { name: "m.room.name" })).not.toBeInTheDocument();

            fetched.resolve([
                stateEvent("m.room.name", "", "$name", { name: "Test room" }),
                stateEvent("org.example.board", "first", "$board", { pinned: true }),
            ]);

            await userEvent.click(await screen.findByRole("button", { name: "org.example.board" }));
            await userEvent.click(screen.getByRole("button", { name: "first" }));
            expect(screen.getByText(/pinned/)).toBeInTheDocument();
            expect(cli.roomState).toHaveBeenCalledWith(roomId);
        });

        it("shows the state this device has, saying so, when the server cannot be asked", async () => {
            cli.roomState = vi.fn().mockRejectedValue(new Error("offline"));
            const room = makeRoomWithStateEvents([nameEvent()], { roomId, mockClient: cli });

            renderComponent(room);

            expect(await screen.findByText(/Could not load all of this room's state/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "m.room.name" })).toBeInTheDocument();
        });

        it("shows nothing of one room while another room's state is fetched", async () => {
            const first = makeRoomWithStateEvents([], { roomId, mockClient: cli });
            const second = makeRoomWithStateEvents([], { roomId: "!second:example.com", mockClient: cli });
            const secondFetched = Promise.withResolvers<IStateEventWithRoomId[]>();
            cli.roomState = vi.fn((id: string) =>
                id === roomId
                    ? Promise.resolve([stateEvent("org.example.first", "", "$first")])
                    : secondFetched.promise,
            );
            const { rerender } = renderComponent(first);
            await userEvent.click(await screen.findByRole("button", { name: "org.example.first" }));

            rerender(explorer(second));

            expect(screen.queryByRole("button", { name: "org.example.first" })).not.toBeInTheDocument();
            expect(screen.queryByText(/org.example.first/)).not.toBeInTheDocument();
            secondFetched.resolve([stateEvent("org.example.second", "", "$second")]);
            expect(await screen.findByRole("button", { name: "org.example.second" })).toBeInTheDocument();
        });

        it("decrypts encrypted state, and lists state it cannot decrypt as it was sent", async () => {
            const encrypted = (id: string, packedKey: string): IStateEventWithRoomId =>
                stateEvent("m.room.encrypted", packedKey, id, { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" });
            cli.roomState = vi
                .fn()
                .mockResolvedValue([encrypted("$topic", "m.room.topic:"), encrypted("$undecryptable", "m.room.name:")]);
            const crypto = {
                decryptEvent: async (event: MatrixEvent) => {
                    if (event.getId() === "$undecryptable") throw new Error("no key");
                    return { clearEvent: { type: "m.room.topic", state_key: "", content: { topic: "Secret" } } };
                },
            } as unknown as Parameters<MatrixEvent["attemptDecryption"]>[0];
            cli.decryptEventIfNeeded = vi.fn((event: MatrixEvent) => event.attemptDecryption(crypto));
            const room = makeRoomWithStateEvents([], { roomId, mockClient: cli });

            renderComponent(room);

            expect(await screen.findByRole("button", { name: "m.room.topic" })).toBeInTheDocument();
            await userEvent.click(screen.getByRole("button", { name: "m.room.encrypted" }));
            expect(screen.getByRole("button", { name: "m.room.name:" })).toBeInTheDocument();
        });

        describe("with state it cannot decrypt", () => {
            const withheld = new Set<string>();
            const crypto = {
                decryptEvent: async (event: MatrixEvent) => {
                    if (withheld.has(event.getId()!)) throw new Error("no key");
                    return { clearEvent: { type: "m.room.name", state_key: "", content: { name: "Secret" } } };
                },
            } as unknown as Parameters<MatrixEvent["attemptDecryption"]>[0];
            let decrypting: MatrixEvent[];

            beforeEach(() => {
                withheld.clear();
                withheld.add("$name");
                decrypting = [];
                cli.roomState = vi.fn().mockResolvedValue([
                    stateEvent("m.room.encrypted", "m.room.name:", "$name", {
                        algorithm: "m.megolm.v1.aes-sha2",
                        ciphertext: "x",
                    }),
                ]);
                cli.decryptEventIfNeeded = vi.fn((event: MatrixEvent) => {
                    decrypting.push(event);
                    return event.attemptDecryption(crypto);
                });
            });

            it("offers no editing of it, having neither its type nor its content", async () => {
                renderComponent(makeRoomWithStateEvents([], { roomId, mockClient: cli }));

                await userEvent.click(await screen.findByRole("button", { name: "m.room.encrypted" }));
                await userEvent.click(screen.getByRole("button", { name: "m.room.name:" }));

                expect(screen.getByText(/ciphertext/)).toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
            });

            it("lists it under what it is once its keys arrive", async () => {
                renderComponent(makeRoomWithStateEvents([], { roomId, mockClient: cli }));
                expect(await screen.findByRole("button", { name: "m.room.encrypted" })).toBeInTheDocument();

                withheld.delete("$name");
                await act(() => decrypting[0].attemptDecryption(crypto, { isRetry: true }));

                expect(await screen.findByRole("button", { name: "m.room.name" })).toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "m.room.encrypted" })).not.toBeInTheDocument();
            });
        });
    });
});
