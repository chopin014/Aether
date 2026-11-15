/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React, { type ComponentProps, type JSX, useContext, useImperativeHandle } from "react";
import { act, fireEvent, render, screen, waitFor } from "test-utils-rtl";
import { type MatrixClient, PendingEventOrdering, Room } from "matrix-js-sdk/src/matrix";
import { useEventPresentation, type TimelineViewExecution } from "@element-hq/web-shared-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestClient, getRoomContext } from "test-utils";

import { RoomTimelineHost } from "./RoomTimelineHost";
import { RoomTimelineSlot } from "./RoomTimelineSlot";
import type { RoomMessagePanel } from "./RoomMessagePanel";
import type { NewTimelineRenderer } from "./NewTimelineRenderer";
import MatrixClientContext from "../../contexts/MatrixClientContext";
import { ScopedRoomContextProvider, useScopedRoomContext } from "../../contexts/ScopedRoomContext";
import { RoomUploadContext, type RoomUploadViewModel } from "../../viewmodels/room/RoomUploadViewModel";
import { RoomTimelineViewModel } from "../../viewmodels/room/timeline/RoomTimelineViewModel";
import { Layout } from "../../settings/enums/Layout";
import * as roomSwitch from "../../performance/RoomSwitchPerformance";

/** What the stand-in renderer was last drawn with. */
const { drawn } = vi.hoisted(() => ({
    drawn: {} as {
        props?: ComponentProps<typeof NewTimelineRenderer>;
        panel?: RoomMessagePanel;
        /** Set to make the renderer throw as it renders. */
        fail?: boolean;
        /** How often the renderer has rendered. */
        renders?: number;
    },
}));

// The renderer draws the timeline; here it shows what reached it.
vi.mock("./NewTimelineRenderer", () => {
    const panel = { isAtEndOfLiveTimeline: () => true } as unknown as RoomMessagePanel;
    drawn.panel = panel;
    return {
        NewTimelineRenderer: (props: ComponentProps<typeof NewTimelineRenderer>): JSX.Element => {
            drawn.props = props;
            drawn.renders = (drawn.renders ?? 0) + 1;
            if (drawn.fail) throw new Error("The renderer broke");
            const { numUnreadMessages } = useScopedRoomContext("numUnreadMessages");
            const upload = useContext(RoomUploadContext);
            const { layout } = useEventPresentation();
            useImperativeHandle(props.panelRef, () => panel, []);
            return (
                <button data-testid="timeline" data-vm-room={props.vm.getSnapshot() ? props.room.roomId : ""}>
                    {`${numUnreadMessages} ${upload ? "upload" : "none"} ${layout}`}
                </button>
            );
        },
    };
});
vi.mock("./NewTimelinePanel", () => ({
    NewTimelinePanel: (): JSX.Element => <div data-testid="ordinary-timeline" />,
}));

describe("RoomTimelineHost", () => {
    let client: MatrixClient;
    let roomA: Room;
    let roomB: Room;
    const upload = {} as RoomUploadViewModel;
    const handlers = { onKeyDown: vi.fn(), onFocus: vi.fn(), panelRef: vi.fn(), outerKeyDown: vi.fn() };
    let start: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        client = createTestClient();
        const room = (id: string): Room =>
            new Room(id, client, "@me:example.org", { pendingEventOrdering: PendingEventOrdering.Detached });
        roomA = room("!a:example.org");
        roomB = room("!b:example.org");
        start = vi.spyOn(RoomTimelineViewModel.prototype, "start").mockImplementation(() => {});
        for (const handler of Object.values(handlers)) handler.mockReset();
        delete drawn.props;
        drawn.fail = false;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** The room view's part: its contexts around the slot it renders in its timeline's place. */
    const roomView = (room: Room, unread = 3): JSX.Element => (
        <ScopedRoomContextProvider {...getRoomContext(room, { numUnreadMessages: unread })}>
            <RoomUploadContext.Provider value={upload}>
                <main data-testid="timeline-area">
                    <RoomTimelineSlot
                        key={room.roomId}
                        room={room}
                        layout={Layout.Bubble}
                        panelRef={handlers.panelRef}
                        onKeyDown={handlers.onKeyDown}
                        onFocus={handlers.onFocus}
                    />
                </main>
            </RoomUploadContext.Provider>
        </ScopedRoomContextProvider>
    );
    const app = (content: JSX.Element | null): JSX.Element => (
        <MatrixClientContext.Provider value={client}>
            <div onKeyDown={handlers.outerKeyDown}>
                <RoomTimelineHost client={client}>{content}</RoomTimelineHost>
            </div>
        </MatrixClientContext.Provider>
    );

    it("draws the room view's timeline inside its slot, with the room view's contexts", () => {
        const mark = vi.spyOn(roomSwitch, "markRoomSwitch");
        render(app(roomView(roomA)));

        const timeline = screen.getByTestId("timeline");
        expect(screen.getByTestId("timeline-area").contains(timeline)).toBe(true);
        expect(timeline).toHaveTextContent("3 upload bubble");
        expect(drawn.props!.room).toBe(roomA);
        expect(mark).toHaveBeenCalledWith("slot", roomA.roomId);
    });

    it("does not draw the timeline again when only the page around the room view renders again", () => {
        const view = roomView(roomA);
        const page = (other: number): JSX.Element =>
            app(
                <>
                    <span data-testid="elsewhere">{other}</span>
                    {view}
                </>,
            );
        const { rerender } = render(page(1));
        const renders = drawn.renders;

        rerender(page(2));

        expect(screen.getByTestId("elsewhere")).toHaveTextContent("2");
        expect(drawn.renders).toBe(renders);
    });

    it("follows what the room view gives its timeline as it changes", () => {
        const { rerender } = render(app(roomView(roomA, 3)));
        rerender(app(roomView(roomA, 7)));

        expect(screen.getByTestId("timeline")).toHaveTextContent("7 upload bubble");
    });

    it("starts the timeline once, and disposes of it when the slot goes, leaving the slot empty", () => {
        const { rerender } = render(app(roomView(roomA)));
        const timeline = drawn.props!.vm;
        expect(start).toHaveBeenCalledTimes(1);
        const area = screen.getByTestId("timeline-area");

        rerender(
            app(
                <ScopedRoomContextProvider {...getRoomContext(roomA, {})}>
                    <main data-testid="timeline-area" />
                </ScopedRoomContextProvider>,
            ),
        );

        expect(timeline.isDisposed).toBe(true);
        expect(screen.queryByTestId("timeline")).toBeNull();
        expect(area.querySelector(".mx_RoomTimelineHost_entry")).toBeNull();
    });

    it("draws a new timeline for each room, and again on coming back to one", () => {
        const { rerender } = render(app(roomView(roomA)));
        const first = drawn.props!.vm;
        rerender(app(roomView(roomB)));
        const second = drawn.props!.vm;
        rerender(app(roomView(roomA)));
        const third = drawn.props!.vm;

        expect(new Set([first, second, third]).size).toBe(3);
        expect(first.isDisposed).toBe(true);
        expect(second.isDisposed).toBe(true);
        expect(third.isDisposed).toBe(false);
        expect(drawn.props!.room).toBe(roomA);
        expect(screen.getAllByTestId("timeline")).toHaveLength(1);
    });

    it("passes keys and focus in the timeline to the room view's handlers, once each", () => {
        render(app(roomView(roomA)));
        const timeline = screen.getByTestId("timeline");

        fireEvent.keyDown(timeline, { key: "PageUp" });
        fireEvent.focusIn(timeline);

        expect(handlers.onKeyDown).toHaveBeenCalledTimes(1);
        expect(handlers.onKeyDown.mock.calls[0][0].key).toBe("PageUp");
        expect(handlers.onFocus).toHaveBeenCalledTimes(1);
        // The key goes on to the app's own handler, as it would from the room view.
        expect(handlers.outerKeyDown).toHaveBeenCalledTimes(1);
    });

    it("unmounts descendants while retaining a model, and rejects the previous visit after returning", () => {
        const { rerender } = render(app(roomView(roomA)));
        const a1 = drawn.props!.execution!;
        const model = drawn.props!.vm;
        vi.spyOn(model, "parkForReuse").mockReturnValue(true);
        vi.spyOn(model, "resumeCompatible").mockReturnValue(true);
        const body = screen.getByTestId("timeline");
        rerender(app(roomView(roomB)));
        expect(body.isConnected).toBe(false);
        expect(model.isDisposed).toBe(false);
        rerender(app(roomView(roomA)));
        expect(drawn.props!.vm).toBe(model);
        expect(a1.isCurrent()).toBe(false);
        expect(a1.onPlaced()).toBe(false);
        expect(drawn.props!.execution!.isCurrent()).toBe(true);
        expect(screen.getAllByTestId("timeline")).toHaveLength(1);
    });

    it("gives the room view the timeline's controls while it is shown, and takes them back as it goes", () => {
        const { rerender } = render(app(roomView(roomA)));
        expect(handlers.panelRef).toHaveBeenLastCalledWith(drawn.panel);

        rerender(app(null));

        expect(handlers.panelRef).toHaveBeenLastCalledWith(null);
    });

    it("stops the timeline acting as soon as its slot is released", () => {
        const { rerender } = render(app(roomView(roomA)));
        const execution: TimelineViewExecution = drawn.props!.execution!;
        expect(execution.isCurrent()).toBe(true);

        rerender(app(null));

        expect(execution.isCurrent()).toBe(false);
        expect(execution.onPlaced()).toBe(false);
    });

    it("tells the timeline, and takes it out of sight and reach, as it gives it up, before React removes it", () => {
        const { rerender } = render(app(roomView(roomA)));
        const execution: TimelineViewExecution = drawn.props!.execution!;
        const timeline = drawn.props!.vm;
        const container = screen.getByTestId("timeline-area").querySelector<HTMLElement>(".mx_RoomTimelineHost_entry")!;
        screen.getByTestId("timeline").focus();
        let seen: Record<string, boolean> | undefined;
        execution.subscribeToInvalidation!(() => {
            seen = {
                current: execution.isCurrent(),
                concealed:
                    container.classList.contains("mx_RoomTimelineHost_entry_revoked") &&
                    container.inert &&
                    container.getAttribute("aria-hidden") === "true",
                focused: container.contains(document.activeElement),
                disposed: timeline.isDisposed,
                inPage: container.isConnected,
            };
        });

        rerender(app(null));

        expect(seen).toEqual({ current: false, concealed: true, focused: false, disposed: false, inPage: true });
        expect(timeline.isDisposed).toBe(true);
    });

    it("draws the timeline in its slot when React replays effects in StrictMode", async () => {
        render(app(roomView(roomA)), { reactStrictMode: true });

        await waitFor(() => expect(screen.getByTestId("timeline")).toBeInTheDocument());
        expect(screen.getByTestId("timeline-area").contains(screen.getByTestId("timeline"))).toBe(true);
        expect(screen.queryByTestId("ordinary-timeline")).toBeNull();
        expect(drawn.props!.vm.isDisposed).toBe(false);
    });

    it("gives the timeline up at once after an error in drawing it, and lets the room view draw its own", () => {
        const { rerender } = render(app(roomView(roomA, 3)));
        const timeline = drawn.props!.vm;

        drawn.fail = true;
        rerender(app(roomView(roomA, 4)));

        expect(timeline.isDisposed).toBe(true);
        expect(screen.queryByTestId("timeline")).toBeNull();
        expect(screen.getByTestId("ordinary-timeline")).toBeInTheDocument();
        expect(screen.getByTestId("timeline-area").querySelector(".mx_RoomTimelineHost_entry")).toBeNull();
    });

    it("lets the room view draw its timeline itself without a host", () => {
        render(<MatrixClientContext.Provider value={client}>{roomView(roomA)}</MatrixClientContext.Provider>);

        expect(screen.getByTestId("ordinary-timeline")).toBeInTheDocument();
        expect(start).not.toHaveBeenCalled();
    });

    it("lets the room view draw its timeline itself when the host is for another client", () => {
        const other = createTestClient();
        render(
            <MatrixClientContext.Provider value={other}>
                <RoomTimelineHost client={client}>{roomView(roomA)}</RoomTimelineHost>
            </MatrixClientContext.Provider>,
        );

        expect(screen.getByTestId("ordinary-timeline")).toBeInTheDocument();
        expect(screen.queryByTestId("timeline")).toBeNull();
    });

    it("disposes of its timeline when it goes itself", () => {
        const { unmount } = render(app(roomView(roomA)));
        const timeline = drawn.props!.vm;

        act(() => unmount());

        expect(timeline.isDisposed).toBe(true);
    });
});
