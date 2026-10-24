/*
Copyright 2024 New Vector Ltd.
Copyright 2022, 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, getByTestId, render, type RenderResult, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import {
    MsgType,
    MatrixEventEvent,
    RelationType,
    EventStatus,
    type MatrixEvent,
    Room,
    type MatrixClient,
    PendingEventOrdering,
    THREAD_RELATION_TYPE,
} from "matrix-js-sdk/src/matrix";
import React, { useState } from "react";
import { flushPromises, mockPlatformPeg, getRoomContext, mkMessage, stubClient, untilDispatch } from "test-utils";
import { mkThread } from "test-utils/threads";

import SettingsStore from "../../settings/SettingsStore";

import ThreadView from "./ThreadView";
import MatrixClientContext from "../../contexts/MatrixClientContext";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { Action } from "../../dispatcher/actions";
import dispatcher from "../../dispatcher/dispatcher";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import DMRoomMap from "../../utils/DMRoomMap";
import ResizeNotifier from "../../utils/ResizeNotifier";
import { ScopedRoomContextProvider } from "../../contexts/ScopedRoomContext.tsx";
import { TimelineRenderingType } from "../../contexts/RoomContext.ts";
import { type ComposerInsertPayload, ComposerType } from "../../dispatcher/payloads/ComposerInsertPayload.ts";
import { SDKContext } from "../../contexts/SDKContext.ts";

describe("ThreadView", () => {
    const ROOM_ID = "!roomId:example.org";
    const SENDER = "@alice:example.org";

    let mockClient: MatrixClient;
    let room: Room;
    let rootEvent: MatrixEvent;

    const onClose = vi.fn();

    let changeEvent: (event: MatrixEvent) => void;

    function TestThreadView({ initialEvent }: { initialEvent?: MatrixEvent }) {
        const [event, setEvent] = useState(rootEvent);
        changeEvent = setEvent;

        return (
            <MatrixClientContext.Provider value={mockClient}>
                <ScopedRoomContextProvider
                    {...getRoomContext(room, {
                        canSendMessages: true,
                    })}
                >
                    <ThreadView
                        room={room}
                        onClose={onClose}
                        mxEvent={event}
                        initialEvent={initialEvent}
                        resizeNotifier={new ResizeNotifier()}
                    />
                </ScopedRoomContextProvider>
                ,
            </MatrixClientContext.Provider>
        );
    }

    async function getComponent(initialEvent?: MatrixEvent): Promise<RenderResult> {
        const renderResult = render(<TestThreadView initialEvent={initialEvent} />, {
            wrapper: ({ children }) => (
                <SDKContext.Provider value={SDKContextClass.instance}>{children}</SDKContext.Provider>
            ),
        });

        await waitFor(() => {
            expect(() => getByTestId(renderResult.container, "spinner")).toThrow();
        });

        return renderResult;
    }

    async function sendMessage(container: HTMLElement, text: string): Promise<void> {
        const composer = getByTestId(container, "basicmessagecomposer");
        await userEvent.click(composer);
        await userEvent.keyboard(text);
        const sendMessageBtn = getByTestId(container, "sendmessagebtn");
        await userEvent.click(sendMessageBtn);
    }

    function expectedMessageBody(rootEvent: MatrixEvent, message: string) {
        return {
            "body": message,
            "m.relates_to": {
                "event_id": rootEvent.getId(),
                "is_falling_back": true,
                "m.in_reply_to": {
                    event_id: rootEvent
                        .getThread()!
                        .lastReply((ev: MatrixEvent) => {
                            return ev.isRelation(THREAD_RELATION_TYPE.name);
                        })!
                        .getId(),
                },
                "rel_type": RelationType.Thread,
            },
            "msgtype": MsgType.Text,
            "m.mentions": {},
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();

        stubClient();
        mockPlatformPeg();
        mockClient = vi.mocked(MatrixClientPeg.safeGet());
        vi.spyOn(mockClient, "supportsThreads").mockReturnValue(true);

        room = new Room(ROOM_ID, mockClient, mockClient.getUserId() ?? "", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });

        const res = mkThread({
            room,
            client: mockClient,
            authorId: mockClient.getUserId()!,
            participantUserIds: [mockClient.getUserId()!],
        });

        rootEvent = res.rootEvent;

        DMRoomMap.makeShared(mockClient);
        vi.spyOn(DMRoomMap.shared(), "getUserIdForRoomId").mockReturnValue(SENDER);
    });

    afterEach(async () => {
        // Unmount dispatches navigation actions; finish them while the fixture client is still installed.
        cleanup();
        await flushPromises();
        vi.restoreAllMocks();
    });

    it("shows the actual starter and channel context in desktop mode and closes with Escape", async () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((setting, ...args) =>
            setting === "feature_desktop_shell" ? true : getValue(setting, ...args),
        );
        const rootListeners = rootEvent.listenerCount(MatrixEventEvent.Replaced);
        const { getByRole, getByText, unmount } = await getComponent();
        expect(getByRole("heading", { name: rootEvent.getContent().body })).toBeVisible();
        expect(getByText(room.name)).toBeVisible();
        rootEvent.getContent().body = "An edited starter";
        await act(() => rootEvent.emit(MatrixEventEvent.Replaced, rootEvent));
        expect(getByRole("heading", { name: "An edited starter" })).toBeVisible();
        await userEvent.click(getByRole("textbox"));
        await userEvent.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledOnce();
        unmount();
        expect(rootEvent.listenerCount(MatrixEventEvent.Replaced)).toBe(rootListeners);
    });

    it("does not include pending root event in the timeline twice", async () => {
        rootEvent = mkMessage({
            user: mockClient.getUserId()!,
            event: true,
            room: room.roomId,
            msg: "root event message " + Math.random(),
        });

        rootEvent.status = EventStatus.SENDING;
        rootEvent.setTxnId("1234");
        room.addPendingEvent(rootEvent, "1234");
        room.updatePendingEvent(rootEvent, EventStatus.SENT, rootEvent.getId());

        const { container } = await getComponent();
        const tiles = container.getElementsByClassName("mx_EventTile");
        expect(tiles.length).toEqual(1);
    });

    it("renders a sent first reply only once while it is still in the pending list", async () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((setting, ...args) =>
            setting === "feature_desktop_shell" ? true : getValue(setting, ...args),
        );
        const reply = mkMessage({
            user: mockClient.getSafeUserId(),
            event: true,
            room: room.roomId,
            msg: "First reply",
        });
        reply.getContent()["m.relates_to"] = { rel_type: RelationType.Thread, event_id: rootEvent.getId() };
        reply.setStatus(EventStatus.SENDING);
        reply.setTxnId("first-reply");
        room.addPendingEvent(reply, "first-reply");
        room.updatePendingEvent(reply, EventStatus.SENT, "$first-reply");
        room.getThread(rootEvent.getId()!)!.addEvent(reply, false);
        const { container } = await getComponent();
        expect(container.querySelectorAll('[data-event-id="$first-reply"]')).toHaveLength(1);
    });

    it("sends a message with the correct fallback", async () => {
        const { container } = await getComponent();

        await sendMessage(container, "Hello world!");

        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            ROOM_ID,
            rootEvent.getId(),
            expectedMessageBody(rootEvent, "Hello world!"),
        );
    });

    it("sends a thread message with the correct fallback", async () => {
        const { container } = await getComponent();

        const { rootEvent: rootEvent2 } = mkThread({
            room,
            client: mockClient,
            authorId: mockClient.getUserId()!,
            participantUserIds: [mockClient.getUserId()!],
        });

        act(() => {
            changeEvent(rootEvent2);
        });

        await sendMessage(container, "yolo");

        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            ROOM_ID,
            rootEvent2.getId(),
            expectedMessageBody(rootEvent2, "yolo"),
        );
    });

    it("sets the correct thread in the room view store", async () => {
        // expect(SDKContextClass.instance.roomViewStore.getThreadId()).toBeNull();
        const { unmount } = await getComponent();
        await waitFor(() => {
            expect(SDKContextClass.instance.roomViewStore.getThreadId()).toBe(rootEvent.getId());
        });

        unmount();
        await waitFor(() => expect(SDKContextClass.instance.roomViewStore.getThreadId()).toBeNull());
    });

    it("clears highlight message in the room view store", async () => {
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockReturnValue(room.roomId);
        const mock = vi.spyOn(dispatcher, "dispatch");
        const { unmount } = await getComponent(rootEvent);
        mock.mockClear();
        const navigation = untilDispatch(Action.ViewRoom, dispatcher);
        await act(async () => {
            unmount();
            await navigation;
        });
        expect(mock).toHaveBeenCalledWith({
            action: Action.ViewRoom,
            room_id: room.roomId,
            metricsTrigger: undefined,
        });
    });

    describe("handles Action.ComposerInsert", () => {
        it("redispatches a payload of timelineRenderingType=Thread", async () => {
            await getComponent();
            const promise = untilDispatch((payload) => {
                try {
                    expect(payload).toEqual({
                        action: Action.ComposerInsert,
                        text: "Hello world",
                        timelineRenderingType: TimelineRenderingType.Thread,
                        composerType: ComposerType.Send,
                    });
                } catch {
                    return false;
                }
                return true;
            }, dispatcher);
            dispatcher.dispatch({
                action: Action.ComposerInsert,
                text: "Hello world",
                timelineRenderingType: TimelineRenderingType.Thread,
            } satisfies ComposerInsertPayload);
            await promise;
        });
        it("ignores payloads with a composerType", async () => {
            await getComponent();
            const promise = untilDispatch(
                (payload) => {
                    try {
                        expect(payload).toStrictEqual({
                            action: Action.ComposerInsert,
                            text: "Hello world",
                            timelineRenderingType: TimelineRenderingType.Thread,
                            composerType: ComposerType.Send,
                        });
                    } catch {
                        return false;
                    }
                    return true;
                },
                dispatcher,
                500,
            );
            dispatcher.dispatch({
                action: Action.ComposerInsert,
                text: "Hello world",
                composerType: ComposerType.Send,
                timelineRenderingType: TimelineRenderingType.Thread,
                // Ensure we don't accidentally pick up this emit by strictly checking above.
                viaTest: true,
            } satisfies ComposerInsertPayload);
            await expect(promise).rejects.toThrow();
        });
        it("ignores payloads with a timelineRenderingType != TimelineRenderingType.Thread", async () => {
            await getComponent();
            const promise = untilDispatch(
                (payload) => {
                    try {
                        expect(payload).toStrictEqual({
                            action: Action.ComposerInsert,
                            text: "Hello world",
                            timelineRenderingType: TimelineRenderingType.Thread,
                            composerType: ComposerType.Send,
                        });
                    } catch {
                        return false;
                    }
                    return true;
                },
                dispatcher,
                500,
            );
            dispatcher.dispatch({
                action: Action.ComposerInsert,
                text: "Hello world",
                composerType: ComposerType.Send,
                timelineRenderingType: TimelineRenderingType.Room,
                // Ensure we don't accidentally pick up this emit by strictly checking above.
                viaTest: true,
            } satisfies ComposerInsertPayload);
            await expect(promise).rejects.toThrow();
        });
    });
});
