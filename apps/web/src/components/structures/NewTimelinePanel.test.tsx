/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { act, fireEvent, render, screen } from "test-utils-rtl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
    EventStatus,
    type MatrixClient,
    type MatrixEvent,
    PendingEventOrdering,
    Room,
    RoomMember,
} from "matrix-js-sdk/src/matrix";
import type { TimelineItem } from "@element-hq/web-shared-components";
import { createTestClient, mkEvent, mkMembership, mkMessage, TestSDKContext } from "test-utils";

import { NewTimelinePanel } from "./NewTimelinePanel";
import type { RoomMessagePanel } from "./RoomMessagePanel";
import { Layout } from "../../settings/enums/Layout";
import EditorStateTransfer from "../../utils/EditorStateTransfer";
import MatrixClientContext from "../../contexts/MatrixClientContext";
import { SDKContext } from "../../contexts/SDKContext";
import * as roomEntry from "../../performance/RoomEntryReady";
import DMRoomMap from "../../utils/DMRoomMap";

// The room's introduction has its own tests and needs the whole room view around it.
vi.mock("../views/rooms/NewRoomIntro", () => ({
    default: ({ as }: { as?: string }) => <div data-testid="new-room-intro" data-as={as} />,
}));

// Says why earlier history cannot be seen, from the room in the room view around it.
vi.mock("../views/rooms/HistoryTile", () => ({
    default: () => <div data-testid="history-tile" />,
}));

const ROOM_ID = "!room:example.org";
const USER_ID = "@alice:example.org";

// The virtualised TimelineView needs real layout, which this environment has none
// of, and it has its own tests in shared-components. Stand in a stub that simply
// draws every row, so these tests cover how this panel renders each kind of row.
const { rowsRendered, paintedItems } = vi.hoisted(() => ({
    rowsRendered: { current: [] as unknown[] },
    paintedItems: { current: undefined as ((items: TimelineItem[]) => void) | undefined },
}));

vi.mock("@element-hq/web-shared-components", async () => {
    const actual = await vi.importActual<typeof import("@element-hq/web-shared-components")>(
        "@element-hq/web-shared-components",
    );
    return {
        ...actual,
        TimelineView: ({
            vm,
            renderItem,
            onItemsPainted,
        }: {
            vm: { getSnapshot: () => { items: TimelineItem[] } };
            renderItem: (item: TimelineItem) => React.ReactNode;
            onItemsPainted?: (items: TimelineItem[]) => void;
        }) => {
            const items = vm.getSnapshot().items;
            rowsRendered.current = items;
            paintedItems.current = onItemsPainted;
            return (
                <div data-testid="timeline-scroller">
                    <div data-testid="timeline-stub">{items.map((item) => renderItem(item))}</div>
                </div>
            );
        },
    };
});

// The view model has its own tests; here it only needs to hand the view a set of
// rows, so stand in a fake whose rows each test controls.
const { vmState } = vi.hoisted(() => ({
    // One snapshot object, replaced only by setRows: useSyncExternalStore compares
    // snapshots by identity, so handing back a fresh object each call would loop.
    vmState: {
        snapshot: {} as Record<string, unknown>,
        setRows(items: unknown[], extra: Record<string, unknown> = {}) {
            this.snapshot = {
                items,
                atLiveEnd: true,
                pendingAnchor: null,
                highlightedEventId: null,
                isAtBottom: true,
                canJumpToReadMarker: false,
                numUnreadMessages: 0,
                hasHighlights: false,
                readReceiptsByEvent: new Map(),
                lastSuccessfulEventId: null,
                ...extra,
            };
        },
    },
}));

const { vmSpies } = vi.hoisted(() => ({
    vmSpies: {
        setShowReadReceipts: vi.fn(),
        setSendReadReceiptOnLoad: vi.fn(),
        jumpToLive: vi.fn(),
        showEvent: vi.fn(),
        jumpToReadMarker: vi.fn(),
        scrollToEventIfNeeded: vi.fn(),
        sendReadReceiptNow: vi.fn(),
        onMarkAllAsRead: vi.fn(),
        constructorOpts: [] as Record<string, unknown>[],
        isAtLiveBottom: false,
        canJumpToReadMarker: false,
    },
}));

vi.mock("../../viewmodels/room/timeline/RoomTimelineViewModel", () => ({
    RoomTimelineViewModel: class {
        public constructor(opts: Record<string, unknown>) {
            vmSpies.constructorOpts.push(opts);
        }
        public setShowReadReceipts = vmSpies.setShowReadReceipts;
        public setSendReadReceiptOnLoad = vmSpies.setSendReadReceiptOnLoad;
        public jumpToLive = vmSpies.jumpToLive;
        public showEvent = vmSpies.showEvent;
        public jumpToReadMarker = vmSpies.jumpToReadMarker;
        public scrollToEventIfNeeded = vmSpies.scrollToEventIfNeeded;
        public sendReadReceiptNow = vmSpies.sendReadReceiptNow;
        public onMarkAllAsRead = vmSpies.onMarkAllAsRead;
        public get isAtLiveBottom(): boolean {
            return vmSpies.isAtLiveBottom;
        }
        public get canJumpToReadMarker(): boolean {
            return vmSpies.canJumpToReadMarker;
        }
        public start = (): void => {};
        public dispose = (): void => {};
        public subscribe = (): (() => void) => (): void => {};
        public getSnapshot = (): Record<string, unknown> => vmState.snapshot;
    },
}));

// EventTile pulls in a large tree that isn't what these tests are about; record
// what the row asked for instead.
const { tileProps, tileMounts } = vi.hoisted(() => ({
    tileProps: { current: [] as Record<string, unknown>[] },
    tileMounts: { current: 0 },
}));

vi.mock("../views/rooms/LegacyEventTileAdapter", () => ({
    LegacyEventTileAdapter: (props: Record<string, unknown>) => {
        tileProps.current.push(props);
        React.useEffect(() => {
            tileMounts.current++;
        }, []);
        return <div data-testid="event-row" />;
    },
}));

describe("<NewTimelinePanel />", () => {
    let client: MatrixClient;
    let room: Room;
    let event: MatrixEvent;

    const renderPanel = (props: Partial<React.ComponentProps<typeof NewTimelinePanel>> = {}) =>
        render(
            <MatrixClientContext.Provider value={client}>
                <SDKContext.Provider value={new TestSDKContext()}>
                    <NewTimelinePanel room={room} {...props} />
                </SDKContext.Provider>
            </MatrixClientContext.Provider>,
        );

    /** Set the rows the timeline is given to draw. */
    const withItems = (items: TimelineItem[], extra: Record<string, unknown> = {}): void => {
        vmState.setRows(items, extra);
    };

    /** A row for `mxEvent`, carrying the event as the view model's rows do. */
    const eventRow = (mxEvent: MatrixEvent, extra: Partial<TimelineItem> = {}): TimelineItem =>
        ({
            key: mxEvent.getId()!,
            kind: "event",
            event: mxEvent,
            continuation: false,
            lastInSection: true,
            ...extra,
        }) as TimelineItem;

    beforeEach(() => {
        vi.restoreAllMocks();
        tileProps.current = [];
        tileMounts.current = 0;
        rowsRendered.current = [];
        vmState.setRows([]);
        for (const spy of [
            vmSpies.setShowReadReceipts,
            vmSpies.setSendReadReceiptOnLoad,
            vmSpies.jumpToLive,
            vmSpies.showEvent,
            vmSpies.jumpToReadMarker,
            vmSpies.scrollToEventIfNeeded,
            vmSpies.sendReadReceiptNow,
            vmSpies.onMarkAllAsRead,
        ]) {
            spy.mockReset();
        }
        vmSpies.isAtLiveBottom = false;
        vmSpies.canJumpToReadMarker = false;
        vmSpies.constructorOpts = [];
        client = createTestClient();
        room = new Room(ROOM_ID, client, USER_ID, { pendingEventOrdering: PendingEventOrdering.Detached });
        vi.spyOn(client, "getRoom").mockReturnValue(room);
        event = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "hello", event: true });
        room.getUnfilteredTimelineSet().addLiveEvent(event, { addToState: false });
    });

    it("releases decorative loading only after conversation rows have painted", () => {
        const ready = vi.spyOn(roomEntry, "notifyRoomEntryReady");
        withItems([eventRow(event)]);
        renderPanel();
        expect(ready).not.toHaveBeenCalled();
        paintedItems.current?.([{ kind: "event-group", key: "notices", events: [] }]);
        expect(ready).not.toHaveBeenCalled();
        act(() => paintedItems.current?.([eventRow(event)]));
        expect(ready).toHaveBeenCalledWith(client, ROOM_ID);
    });

    it("does not release decorative work from a hidden timeline", () => {
        const ready = vi.spyOn(roomEntry, "notifyRoomEntryReady");
        withItems([eventRow(event)]);
        renderPanel({ hidden: true });
        paintedItems.current?.([eventRow(event)]);
        expect(ready).not.toHaveBeenCalled();
    });

    it("draws the event the row carries", () => {
        withItems([eventRow(event)]);

        renderPanel();

        expect(screen.getByTestId("event-row")).toBeInTheDocument();
        expect(tileProps.current[0].mxEvent).toBe(event);
    });

    it("keeps a message's tile as its id changes from the one it was sent with to the server's", () => {
        const mine = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "mine", event: true });
        withItems([eventRow(mine, { key: "~local", tileKey: "txn-1" } as Partial<TimelineItem>)]);
        const view = renderPanel();
        expect(tileMounts.current).toBe(1);

        withItems([eventRow(mine, { tileKey: "txn-1" } as Partial<TimelineItem>)]);
        view.rerender(
            <MatrixClientContext.Provider value={client}>
                <SDKContext.Provider value={new TestSDKContext()}>
                    <NewTimelinePanel room={room} />
                </SDKContext.Provider>
            </MatrixClientContext.Provider>,
        );

        expect(tileProps.current.at(-1)?.mxEvent).toBe(mine);
        expect(tileMounts.current).toBe(1);
    });

    it("marks the newest event's tile as the last, so its time shows, as in the old timeline", () => {
        const newer = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "newer", event: true });
        withItems([eventRow(event), eventRow(newer), { kind: "loading", key: "forward-loading" }]);

        renderPanel();

        expect(tileProps.current.map((props) => [props.mxEvent, props.last])).toEqual([
            [event, false],
            [newer, true],
        ]);
    });

    describe("as the newest event moves in and out of an open summary", () => {
        const members = (): MatrixEvent[] =>
            Array.from({ length: 3 }, (_, index) => {
                const user = `@member${index}:example.org`;
                return mkMembership({
                    room: ROOM_ID,
                    user,
                    skey: user,
                    mship: "join",
                    event: true,
                    target: new RoomMember(ROOM_ID, user),
                });
            });
        const rerenderPanel = (view: ReturnType<typeof renderPanel>): void =>
            view.rerender(
                <MatrixClientContext.Provider value={client}>
                    <SDKContext.Provider value={new TestSDKContext()}>
                        <NewTimelinePanel room={room} />
                    </SDKContext.Provider>
                </MatrixClientContext.Provider>,
            );
        /** Whether the tile last drawn for `mxEvent` was marked the newest. */
        const lastOf = (mxEvent: MatrixEvent): unknown =>
            [...tileProps.current].reverse().find((props) => props.mxEvent === mxEvent)?.last;

        it("marks its final event when a message after it goes", () => {
            const group = members();
            const pending = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "sending", event: true });
            withItems([{ key: "summary", kind: "event-group", events: group }, eventRow(pending)]);
            const view = renderPanel();
            fireEvent.click(screen.getByRole("button", { name: "Expand" }));
            expect(lastOf(group[2])).toBe(false);

            // The message is cancelled before it is sent.
            withItems([{ key: "summary", kind: "event-group", events: [...group] }]);
            rerenderPanel(view);

            expect(lastOf(group[2])).toBe(true);
        });

        it("unmarks its final event when a message arrives after it", () => {
            const group = members();
            withItems([{ key: "summary", kind: "event-group", events: group }]);
            const view = renderPanel();
            fireEvent.click(screen.getByRole("button", { name: "Expand" }));
            expect(lastOf(group[2])).toBe(true);

            const arrived = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "arrived", event: true });
            withItems([{ key: "summary", kind: "event-group", events: [...group] }, eventRow(arrived)]);
            rerenderPanel(view);

            expect(lastOf(group[2])).toBe(false);
            expect(lastOf(arrived)).toBe(true);
        });
    });

    it("marks the newest event inside a closing summary as the last", () => {
        const members = Array.from({ length: 3 }, (_, index) => {
            const user = `@member${index}:example.org`;
            return mkMembership({
                room: ROOM_ID,
                user,
                skey: user,
                mship: "join",
                event: true,
                target: new RoomMember(ROOM_ID, user),
            });
        });
        withItems([eventRow(event), { key: "summary", kind: "event-group", events: members }]);

        renderPanel();
        fireEvent.click(screen.getByRole("button", { name: "Expand" }));

        const lastOf = new Map(tileProps.current.map((props) => [props.mxEvent, props.last]));
        expect([event, ...members].map((member) => lastOf.get(member))).toEqual([false, false, false, true]);
    });

    it("shows a compact membership group and mounts its individual tiles only when expanded", () => {
        const events = Array.from({ length: 3 }, (_, index) => {
            const user = `@member${index}:example.org`;
            return mkMembership({
                room: ROOM_ID,
                user,
                skey: user,
                mship: "join",
                event: true,
                target: new RoomMember(ROOM_ID, user),
            });
        });
        withItems([{ key: events[0].getId()!, kind: "event-group", events }]);
        const { container } = renderPanel();
        expect(container.querySelector(".mx_GenericEventListSummary")?.tagName).toBe("DIV");
        expect(screen.queryAllByTestId("event-row")).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Expand" }));
        expect(screen.getAllByTestId("event-row")).toHaveLength(3);
        expect(tileProps.current.map((props) => props.mxEvent)).toEqual(events);
        expect(container.querySelectorAll("ol > li")).toHaveLength(3);
        fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
        expect(screen.queryAllByTestId("event-row")).toHaveLength(0);
    });

    it("shows a summary of one event as that event, inside the summary, as the old timeline does", () => {
        const user = "@member:example.org";
        const event = mkMembership({
            room: ROOM_ID,
            user,
            skey: user,
            mship: "join",
            event: true,
            target: new RoomMember(ROOM_ID, user),
        });
        withItems([{ key: `summary-${event.getId()}-0`, kind: "event-group", events: [event] }]);
        const { container } = renderPanel();
        const summary = container.querySelector(".mx_GenericEventListSummary");
        expect(summary).toHaveAttribute("data-expanded", "true");
        expect(summary).toHaveAttribute("data-layout", "group");
        expect(screen.queryByRole("button", { name: "Expand" })).not.toBeInTheDocument();
        expect(summary?.querySelectorAll("ol > li [data-testid='event-row']")).toHaveLength(1);
        expect(tileProps.current.map((props) => props.mxEvent)).toEqual([event]);
        expect(screen.queryByTestId("history-tile")).not.toBeInTheDocument();
    });

    it("draws each tile in a summary from its own row", () => {
        const first = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "first", event: true });
        const second = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "second", event: true });
        withItems([
            {
                key: "summary-$first-0",
                kind: "event-group",
                events: [first, second],
                rows: [eventRow(first, { lastInSection: false }), eventRow(second, { continuation: true })],
            } as TimelineItem,
        ]);

        renderPanel();

        expect(tileProps.current.map((props) => [props.mxEvent, props.continuation, props.lastInSection])).toEqual([
            [first, false, false],
            [second, true, true],
        ]);
    });

    it("draws each tile in a summary given no rows on its own", () => {
        const first = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "first", event: true });
        const second = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "second", event: true });
        withItems([{ key: "summary-$first-0", kind: "event-group", events: [first, second] }]);

        renderPanel();

        expect(tileProps.current.map((props) => [props.mxEvent, props.continuation, props.lastInSection])).toEqual([
            [first, false, true],
            [second, false, true],
        ]);
    });

    it("gives each tile in a summary its own send state", () => {
        // A message a module sums up, still being sent.
        const sending = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "grouped", event: true });
        vi.spyOn(sending, "getAssociatedStatus").mockReturnValue(EventStatus.SENDING);
        withItems([{ key: `summary-${sending.getId()}-0`, kind: "event-group", events: [sending] }]);

        renderPanel();

        expect(tileProps.current.map((props) => [props.mxEvent, props.sendState])).toEqual([[sending, "sending"]]);
    });

    it("says why nothing earlier can be seen above a summary that opens the room's history", () => {
        const events = Array.from({ length: 3 }, (_, index) => {
            const user = `@member${index}:example.org`;
            return mkMembership({
                room: ROOM_ID,
                user,
                skey: user,
                mship: "join",
                event: true,
                target: new RoomMember(ROOM_ID, user),
            });
        });
        const item: TimelineItem = { key: "summary-$first-0", kind: "event-group", events };
        withItems([item]);
        const view = renderPanel();
        expect(screen.queryByTestId("history-tile")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Expand" }));

        // Paging back reaches the start of what the reader can see.
        withItems([{ ...item, startsHistory: true }]);
        view.rerender(
            <MatrixClientContext.Provider value={client}>
                <SDKContext.Provider value={new TestSDKContext()}>
                    <NewTimelinePanel room={room} />
                </SDKContext.Provider>
            </MatrixClientContext.Provider>,
        );
        const tile = screen.getByTestId("history-tile");
        expect(tile.nextElementSibling).toHaveClass("mx_GenericEventListSummary");
        // The summary the reader opened stays open.
        expect(tile.nextElementSibling).toHaveAttribute("data-expanded", "true");
        expect(screen.getAllByTestId("event-row")).toHaveLength(3);
    });

    it("draws pictures sent together as a grid of tiles, as the old timeline's gallery does", () => {
        const pictures = Array.from({ length: 4 }, (_, index) =>
            mkMessage({ room: ROOM_ID, user: USER_ID, msg: `picture ${index}`, event: true }),
        );
        vi.spyOn(pictures[3], "getAssociatedStatus").mockReturnValue(EventStatus.SENDING);
        withItems([
            { key: `gallery-${pictures[0].getId()}`, kind: "event-group", events: pictures, variant: "gallery" },
        ]);

        const { container } = renderPanel();

        const list = container.querySelector(".mx_DesktopGallery > ol.mx_DesktopGallery_list");
        expect(list).toHaveAttribute("data-columns", "2");
        expect((list as HTMLElement).style.getPropertyValue("--mx-desktop-gallery-columns")).toBe("2");
        expect(
            tileProps.current.map((props) => [props.mxEvent, props.as, props.continuation, props.lastInSection]),
        ).toEqual([
            [pictures[0], "li", true, false],
            [pictures[1], "li", true, false],
            [pictures[2], "li", true, false],
            [pictures[3], "li", true, true],
        ]);
        expect(tileProps.current.map((props) => props.sendState)).toEqual([undefined, undefined, undefined, "sending"]);
    });

    describe("a gallery", () => {
        const pictures = (): MatrixEvent[] =>
            Array.from({ length: 2 }, (_, index) =>
                mkMessage({ room: ROOM_ID, user: USER_ID, msg: `picture ${index}`, event: true }),
            );
        // The message after the pictures continues them, so neither closes the section.
        const continuing = (event: MatrixEvent): TimelineItem =>
            eventRow(event, { continuation: true, lastInSection: false });
        const gallery = (events: MatrixEvent[]): TimelineItem =>
            ({
                key: `gallery-${events[0].getId()}`,
                kind: "event-group",
                events,
                variant: "gallery",
                rows: events.map(continuing),
            }) as TimelineItem;

        it("draws each picture from its own row", () => {
            const events = pictures();
            withItems([gallery(events)]);

            renderPanel();

            expect(
                tileProps.current.map((props) => [props.mxEvent, props.as, props.continuation, props.lastInSection]),
            ).toEqual([
                [events[0], "li", true, false],
                [events[1], "li", true, false],
            ]);
        });

        it("is a list even to Safari, which ignores lists without their list style", () => {
            withItems([gallery(pictures())]);

            const { container } = renderPanel();

            expect(container.querySelector(".mx_DesktopGallery_list")).toHaveAttribute("role", "list");
        });
    });

    describe("the start of a room", () => {
        const setUp = (): MatrixEvent[] => [
            mkMembership({ room: ROOM_ID, user: USER_ID, skey: USER_ID, mship: "join", event: true }),
            mkEvent({
                room: ROOM_ID,
                user: USER_ID,
                type: "m.room.join_rules",
                skey: "",
                content: { join_rule: "invite" },
                event: true,
            }),
            // A summary stands in for three events or more, as in the old timeline.
            mkEvent({
                room: ROOM_ID,
                user: USER_ID,
                type: "m.room.history_visibility",
                skey: "",
                content: { history_visibility: "shared" },
                event: true,
            }),
        ];
        const dmWith = (userId: string | undefined): void => {
            vi.spyOn(DMRoomMap, "shared").mockReturnValue({
                getUserIdForRoomId: () => userId,
            } as unknown as DMRoomMap);
        };

        it("introduces the room and sums up how its creator set it up, expanding to the events", () => {
            dmWith(undefined);
            const events = setUp();
            withItems([{ key: "creation-$create", kind: "event-group", events, variant: "creation" }]);

            renderPanel();

            // The row is the list item: the intro must not be another one inside it.
            expect(screen.getByTestId("new-room-intro")).toHaveAttribute("data-as", "div");
            expect(screen.getByText(`${USER_ID} created and configured the room.`)).toBeInTheDocument();
            expect(screen.queryAllByTestId("event-row")).toHaveLength(0);
            fireEvent.click(screen.getByRole("button", { name: "Expand" }));
            expect(tileProps.current.map((props) => props.mxEvent)).toEqual(events);
        });

        it("puts the introduction and the summary in the row side by side, as the old timeline's list items", () => {
            dmWith(undefined);
            withItems([{ key: "creation-$create", kind: "event-group", events: setUp(), variant: "creation" }]);

            renderPanel();

            // The stand-in timeline draws each row's content straight into its list, as a row does.
            const row = screen.getByTestId("timeline-stub");
            expect(screen.getByTestId("new-room-intro").parentElement).toBe(row);
            expect(row.querySelector(".mx_GenericEventListSummary")!.parentElement).toBe(row);
        });

        it("shows a short start of a room as its events, under the introduction", () => {
            dmWith(undefined);
            withItems([
                { key: "creation-$create", kind: "event-group", events: setUp().slice(0, 2), variant: "creation" },
            ]);

            renderPanel();

            expect(screen.getByTestId("new-room-intro")).toBeInTheDocument();
            expect(screen.queryByText(`${USER_ID} created and configured the room.`)).not.toBeInTheDocument();
            expect(screen.getAllByTestId("event-row")).toHaveLength(2);
        });

        it("says a direct message was created", () => {
            dmWith("@bob:example.org");
            withItems([{ key: "creation-$create", kind: "event-group", events: setUp(), variant: "creation" }]);

            renderPanel();

            expect(screen.getByText(`${USER_ID} created this DM.`)).toBeInTheDocument();
        });
    });

    it("draws a row whose event the room no longer has", () => {
        // A gappy sync resets the room's timeline, dropping every loaded event; the rows the view
        // model last published still hold theirs, and are drawn until it publishes new ones.
        const gone = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "gone", event: true });
        expect(room.findEventById(gone.getId()!)).toBeUndefined();
        withItems([eventRow(gone)]);

        renderPanel();

        expect(tileProps.current[0].mxEvent).toBe(gone);
    });

    it("passes the row's send state to the tile", () => {
        withItems([eventRow(event, { sendState: "failed" })]);

        renderPanel();

        expect(tileProps.current[0].sendState).toBe("failed");
    });

    it("gives a delivered message no send state", () => {
        withItems([eventRow(event)]);

        renderPanel();

        expect(tileProps.current[0].sendState).toBeUndefined();
    });

    it('labels the read marker "New"', () => {
        withItems([{ key: "$marker", kind: "read-marker" } as TimelineItem]);

        renderPanel();

        expect(screen.getByText("New")).toBeInTheDocument();
    });

    it("announces the loading row to screen readers", () => {
        withItems([{ key: "loading", kind: "loading" } as TimelineItem]);

        renderPanel();

        expect(screen.getByRole("progressbar")).toBeInTheDocument();
    });

    it("labels a date separator the way the old timeline does", () => {
        withItems([{ key: "$sep", kind: "date-separator", ts: Date.now() } as TimelineItem]);

        renderPanel();

        // A relative label, from the shared DateSeparatorViewModel.
        expect(screen.getByText(/today/i)).toBeInTheDocument();
    });

    it("styles a date separator as the old timeline does", () => {
        withItems([{ key: "$sep", kind: "date-separator", ts: Date.now() } as TimelineItem]);

        const { container } = renderPanel();

        expect(container.querySelector(".mx_TimelineSeparator")).toHaveTextContent(/today/i);
    });

    it("draws nothing for a gap, matching the old timeline", () => {
        withItems([{ key: "$gap", kind: "gap" } as TimelineItem]);

        renderPanel();

        expect(screen.getByTestId("timeline-stub")).toBeEmptyDOMElement();
    });

    it("lays messages out as IRC, with the name column's drag handle, when IRC is selected", () => {
        withItems([eventRow(event)]);

        const { container } = renderPanel({ layout: Layout.IRC });

        expect(tileProps.current[0].layout).toBe(Layout.IRC);
        const panel = container.querySelector(".mx_NewTimelinePanel");
        expect(panel).toHaveClass("mx_IRCLayout");
        expect(panel?.querySelector(":scope > .mx_ProfileResizer")).not.toBeNull();
    });

    it("has no IRC name column in other layouts", () => {
        withItems([eventRow(event)]);

        const { container } = renderPanel({ layout: Layout.Group });

        expect(container.querySelector(".mx_NewTimelinePanel")).not.toHaveClass("mx_IRCLayout");
        expect(container.querySelector(".mx_ProfileResizer")).toBeNull();
    });

    it("passes the message layout through unchanged", () => {
        withItems([eventRow(event)]);

        renderPanel({ layout: Layout.Bubble });

        expect(tileProps.current[0].layout).toBe(Layout.Bubble);
    });

    it("gives the edit state only to the message being edited", () => {
        const other = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "other", event: true });
        room.getUnfilteredTimelineSet().addLiveEvent(other, { addToState: false });
        const editState = new EditorStateTransfer(event);
        withItems([eventRow(event), eventRow(other)]);

        renderPanel({ editState });

        expect(tileProps.current[0].editState).toBe(editState);
        expect(tileProps.current[1].editState).toBeUndefined();
    });

    it("hides the panel without unmounting it", () => {
        withItems([]);

        const { container } = renderPanel({ hidden: true });

        expect(container.querySelector(".mx_NewTimelinePanel")).toHaveClass("mx_NewTimelinePanel_hidden");
        expect(screen.getByTestId("timeline-stub")).toBeInTheDocument();
    });

    it("lets tiles look up relations, so reactions can render", () => {
        withItems([eventRow(event)]);

        renderPanel();

        const getRelationsForEvent = tileProps.current[0].getRelationsForEvent as (
            id: string,
            rel: string,
            type: string,
        ) => unknown;
        expect(typeof getRelationsForEvent).toBe("function");
        // Nothing has reacted, so there are no relations to find — but the lookup
        // has to reach the room without throwing.
        expect(getRelationsForEvent(event.getId()!, "m.annotation", "m.reaction")).toBeUndefined();
    });

    describe("controls for the room view", () => {
        it("passes the room view's requests to the view model", () => {
            withItems([eventRow(event)]);
            const ref = React.createRef<RoomMessagePanel>();
            renderPanel({ panelRef: ref });
            const panel = ref.current!;

            expect(panel.isAtEndOfLiveTimeline()).toBe(false);
            expect(panel.canResetTimeline()).toBe(false);
            vmSpies.isAtLiveBottom = true;
            vmSpies.canJumpToReadMarker = true;
            expect(panel.isAtEndOfLiveTimeline()).toBe(true);
            expect(panel.canResetTimeline()).toBe(true);
            expect(panel.canJumpToReadMarker()).toBe(true);

            panel.jumpToLiveTimeline();
            panel.jumpToReadMarker();
            void panel.forgetReadMarker();
            panel.scrollToEventIfNeeded("$edited");
            panel.scrollToEventIfNeeded();
            void panel.sendReadReceipts();
            void panel.updateReadMarker();
            expect(vmSpies.jumpToLive).toHaveBeenCalledTimes(1);
            expect(vmSpies.jumpToReadMarker).toHaveBeenCalledTimes(1);
            expect(vmSpies.onMarkAllAsRead).toHaveBeenCalledTimes(1);
            expect(vmSpies.scrollToEventIfNeeded).toHaveBeenCalledExactlyOnceWith("$edited");
            expect(vmSpies.sendReadReceiptNow).toHaveBeenCalledTimes(1);
            // The panel remembers its own position, so the room view has none to save.
            expect(panel.getScrollState).toBeUndefined();
        });

        it("shows messages navigated to after opening, including the same one again", () => {
            withItems([eventRow(event)]);
            const scrolledIntoView = vi.fn();
            const panel = (props: Partial<React.ComponentProps<typeof NewTimelinePanel>>): React.ReactElement => (
                <MatrixClientContext.Provider value={client}>
                    <SDKContext.Provider value={new TestSDKContext()}>
                        <NewTimelinePanel room={room} onEventScrolledIntoView={scrolledIntoView} {...props} />
                    </SDKContext.Provider>
                </MatrixClientContext.Provider>
            );
            const { rerender } = render(panel({ highlightedEventId: "$first", eventScrollIntoView: true }));
            // The view model opens at the first one itself.
            expect(vmSpies.showEvent).not.toHaveBeenCalled();
            expect(scrolledIntoView).toHaveBeenLastCalledWith("$first");

            rerender(panel({ highlightedEventId: "$first", eventScrollIntoView: false }));
            rerender(panel({ highlightedEventId: "$second", eventScrollIntoView: true }));
            expect(vmSpies.showEvent).toHaveBeenLastCalledWith("$second");
            rerender(panel({ highlightedEventId: "$second", eventScrollIntoView: false }));
            expect(vmSpies.showEvent).toHaveBeenCalledTimes(1);

            // Going to the same message again.
            rerender(panel({ highlightedEventId: "$second", eventScrollIntoView: true }));
            expect(vmSpies.showEvent).toHaveBeenCalledTimes(2);
        });

        it("scrolls a page at a time and jumps to either end from the keyboard", () => {
            withItems([eventRow(event)]);
            const ref = React.createRef<RoomMessagePanel>();
            renderPanel({ panelRef: ref });
            const scroller = screen.getByTestId("timeline-scroller");
            Object.defineProperty(scroller, "clientHeight", { value: 500 });
            scroller.scrollBy = vi.fn();
            scroller.scrollTo = vi.fn();

            ref.current!.handleScrollKey(new KeyboardEvent("keydown", { key: "PageUp" }));
            expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: -450 });
            ref.current!.handleScrollKey(new KeyboardEvent("keydown", { key: "PageDown" }));
            expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: 450 });
            ref.current!.handleScrollKey(new KeyboardEvent("keydown", { key: "Home", ctrlKey: true }));
            expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0 });
            ref.current!.handleScrollKey(new KeyboardEvent("keydown", { key: "End", ctrlKey: true }));
            expect(vmSpies.jumpToLive).toHaveBeenCalledTimes(1);
            ref.current!.handleScrollKey(new KeyboardEvent("keydown", { key: "a" }));
            expect(scroller.scrollBy).toHaveBeenCalledTimes(2);
        });
    });

    describe("read receipts", () => {
        const eventRow = (): TimelineItem =>
            ({ key: event.getId()!, kind: "event", continuation: false, lastInSection: true }) as TimelineItem;

        it("renders receipts provided by the view model", () => {
            const receipts = [{ userId: "@bob:example.org", roomMember: null, ts: 1000 }];
            withItems([eventRow()], { readReceiptsByEvent: new Map([[event.getId()!, receipts]]) });

            renderPanel();

            expect(tileProps.current[0].readReceipts).toBe(receipts);
            expect(tileProps.current[0].showReadReceipts).toBe(true);
            // Shared by every tile so an avatar can animate from its old row to its new one.
            expect(tileProps.current[0].readReceiptMap).toEqual({});
        });

        it('puts the "Sent" tick only on the message the view model chose', () => {
            const other = mkMessage({ room: ROOM_ID, user: USER_ID, msg: "other", event: true });
            room.getUnfilteredTimelineSet().addLiveEvent(other, { addToState: false });
            withItems(
                [
                    eventRow(),
                    { key: other.getId()!, kind: "event", continuation: false, lastInSection: true } as TimelineItem,
                ],
                { lastSuccessfulEventId: other.getId() },
            );

            renderPanel();

            expect(tileProps.current[0].lastSuccessful).toBe(false);
            expect(tileProps.current[1].lastSuccessful).toBe(true);
        });

        it("follows the room's read receipts setting", () => {
            withItems([eventRow()]);

            const { rerender } = renderPanel({ showReadReceipts: false });
            expect(vmSpies.constructorOpts[0].showReadReceipts).toBe(false);
            expect(tileProps.current[0].showReadReceipts).toBe(false);

            rerender(
                <MatrixClientContext.Provider value={client}>
                    <SDKContext.Provider value={new TestSDKContext()}>
                        <NewTimelinePanel room={room} showReadReceipts={true} />
                    </SDKContext.Provider>
                </MatrixClientContext.Provider>,
            );

            expect(vmSpies.setShowReadReceipts).toHaveBeenLastCalledWith(true);
        });

        it("reads what it loads when the room view says the reader opened the room", () => {
            withItems([eventRow()]);

            const { rerender } = renderPanel({ sendReadReceiptOnLoad: true });
            expect(vmSpies.constructorOpts[0].sendReadReceiptOnLoad).toBe(true);

            rerender(
                <MatrixClientContext.Provider value={client}>
                    <SDKContext.Provider value={new TestSDKContext()}>
                        <NewTimelinePanel room={room} sendReadReceiptOnLoad={false} />
                    </SDKContext.Provider>
                </MatrixClientContext.Provider>,
            );

            expect(vmSpies.setSendReadReceiptOnLoad).toHaveBeenLastCalledWith(false);
        });
    });
});
