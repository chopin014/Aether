/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, {
    Fragment,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type JSX,
    type ReactNode,
    type Ref,
} from "react";
import {
    TimelineView,
    tileKeyOf,
    useViewModel,
    type TimelineItem,
    type TimelineViewExecution,
    ReadMarker,
} from "@element-hq/web-shared-components";
import { InlineSpinner } from "@vector-im/compound-web";
import classNames from "classnames";

import {
    EventType,
    type MatrixClient,
    type MatrixEvent,
    type RelationType,
    type Relations,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { notifyRoomEntryReady } from "../../performance/RoomEntryReady";
import { markRoomSwitch } from "../../performance/RoomSwitchPerformance";
import type { RoomTimelineViewModel } from "../../viewmodels/room/timeline/RoomTimelineViewModel";
import { sendStateOf } from "../../viewmodels/room/timeline/sendState";
import { useMatrixClientContext } from "../../contexts/MatrixClientContext";
import { LegacyEventTileAdapter } from "../views/rooms/LegacyEventTileAdapter";
import type { GetRelationsForEvent, IReadReceiptProps } from "../views/rooms/EventTile";
import { Layout } from "../../settings/enums/Layout";
import { useSettingValue } from "../../hooks/useSettings";
import { useRoomMemberCount } from "../../hooks/useRoomMembers";
import { _t } from "../../languageHandler";
import type { RoomPermalinkCreator } from "../../utils/permalinks/Permalinks";
import type EditorStateTransfer from "../../utils/EditorStateTransfer";
import { DateSeparatorWrapper } from "./DateSeparatorWrapper";
import EventListSummary from "../views/elements/EventListSummary";
import GenericEventListSummary from "../views/elements/GenericEventListSummary";
import NewRoomIntro from "../views/rooms/NewRoomIntro";
import HistoryTile from "../views/rooms/HistoryTile";
import { galleryColumns } from "../../utils/gallery";
import IRCTimelineProfileResizer from "../views/elements/IRCTimelineProfileResizer";
import DMRoomMap from "../../utils/DMRoomMap";
import type { IReadReceiptPosition } from "../views/rooms/ReadReceiptMarker";
import { getKeyBindingsManager } from "../../KeyBindingsManager";
import { KeyBindingAction } from "../../accessibility/KeyboardShortcuts";
import type { RoomMessagePanel } from "./RoomMessagePanel";

/** What {@link NewTimelineRenderer} draws, and how, besides the view model it is given. */
interface NewTimelineRendererProps {
    room: Room;
    highlightedEventId?: string;
    /**
     * How messages are laid out. RoomView watches this setting for us, so a change
     * arrives here as a new prop.
     */
    layout?: Layout;
    /** Keep the panel mounted but invisible (e.g. while search results are shown). */
    hidden?: boolean;
    /** Used by tiles for permalinks in message bodies and context menus. */
    permalinkCreator?: RoomPermalinkCreator;
    /** Whether tiles render URL previews under messages. */
    showUrlPreview?: boolean;
    /** Whether tiles render reactions under messages. */
    showReactions?: boolean;
    /** Set while a message is being edited; the matching tile renders the edit composer. */
    editState?: EditorStateTransfer;
    /** Whether other users' read receipts are drawn beside messages (the `showReadReceipts` setting). */
    showReadReceipts?: boolean;
    /** Receives the panel's controls, which the room view uses for shortcuts, sending and editing. */
    panelRef?: Ref<RoomMessagePanel>;
    /**
     * Whether `highlightedEventId` still has to be brought into view. The room view sets it for each navigation
     * to a message and clears it through `onEventScrolledIntoView`, so going to the same message again works.
     */
    eventScrollIntoView?: boolean;
    /** Called once a navigation to `highlightedEventId` has been handled. */
    onEventScrolledIntoView?: (eventId?: string) => void;
    /** When the timeline may act, for one a host lends to the room view; see `TimelineViewExecution`. */
    execution?: TimelineViewExecution;
}

/** How far Page Up and Page Down move, as a share of the visible height, keeping some context on screen. */
const PAGE_SCROLL_FRACTION = 0.9;

/**
 * The space above the first row and below the last: the old timeline's list padding, `--RoomView_MessageList-padding`,
 * which the rows also take at their sides (_NewTimelinePanel.pcss).
 */
const LIST_PADDING_PX = 18;

/** Everything a timeline row needs from the panel to draw itself. */
interface RenderItemContext {
    roomId: string;
    highlightedId: string | null;
    effectiveLayout: Layout;
    /**
     * Whether tiles leave out their sender's name: in the bubble layout, in a room of two at most, where the side a
     * bubble is on already says who wrote it, as in the old timeline.
     */
    hideSender: boolean;
    permalinkCreator?: RoomPermalinkCreator;
    showUrlPreview?: boolean;
    showReactions?: boolean;
    showReadReceipts: boolean;
    /** Other users' receipts for each message, as computed by the view model. */
    readReceiptsByEvent: ReadonlyMap<string, IReadReceiptProps[]>;
    /**
     * Where each user's receipt avatar was last drawn. One object shared by every tile, so a
     * receipt moving to a newer message can animate from its old row to its new one.
     */
    readReceiptMap: { [userId: string]: IReadReceiptPosition };
    /** The message showing a "Sent" tick in place of read receipts, if any. */
    lastSuccessfulEventId: string | null;
    /** The newest event drawn, whose tile always shows its time, as in the old timeline. */
    lastEventId: string | null;
    isTwelveHour: boolean;
    alwaysShowTimestamps: boolean;
    editState?: EditorStateTransfer;
    getRelationsForEvent: GetRelationsForEvent;
}

/** The newest event among the rows, including one inside a summary, or null when there is none. */
function lastEventIdOf(items: readonly TimelineItem[]): string | null {
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.kind === "event") return item.key;
        if (item.kind === "event-group" && item.events.length > 0) {
            return (item.events[item.events.length - 1] as MatrixEvent).getId() ?? null;
        }
    }
    return null;
}

/** A row for one event drawn inside a group, with its send state read as the view model reads a row's own. */
function groupedEvent(event: MatrixEvent, continuation = false, lastInSection = true): TimelineItem {
    return { kind: "event", key: event.getId()!, event, continuation, lastInSection, sendState: sendStateOf(event) };
}

/**
 * Pictures one person sent together, after the first of them, as a grid under it, as the old timeline's
 * `GalleryGrouper` draws them. Each picture is still its own tile, with its own actions and reactions.
 */
function renderGallery(key: string, rows: TimelineItem[], ctx: RenderItemContext): ReactNode {
    const columns = galleryColumns(rows.length);
    const style = { "--mx-desktop-gallery-columns": columns } as CSSProperties;
    return (
        <div key={key} className="mx_DesktopGallery">
            {/* The list style is removed, which makes Safari stop announcing it as a list unless told. */}
            {/* oxlint-disable-next-line jsx-a11y/no-redundant-roles */}
            <ol className="mx_DesktopGallery_list" style={style} data-columns={columns} role="list">
                {/* The grid's styles expect tiles as its list items. */}
                {rows.map((row) => renderTimelineItem(row, ctx, "li"))}
            </ol>
        </div>
    );
}

/**
 * The room's introduction and the summary of how its creator set it up, as the old timeline draws the start of a room.
 * The summary expands to the events it stands for.
 */
function renderCreation(key: string, events: MatrixEvent[], ctx: RenderItemContext): ReactNode {
    // The create event has no profile: the latest event in the summary does.
    const last = events[events.length - 1];
    const creator = last.sender?.name ?? last.getSender();
    const summaryText = DMRoomMap.shared().getUserIdForRoomId(ctx.roomId)
        ? _t("timeline|creation_summary_dm", { creator })
        : _t("timeline|creation_summary_room", { creator });
    return (
        // The intro and the summary sit in the row side by side, as separate items of the old timeline's list do.
        <Fragment key={key}>
            {/* The row is already the list item, so the intro is a plain block in it. */}
            <NewRoomIntro as="div" />
            <GenericEventListSummary
                as="div"
                events={events}
                summaryMembers={last.sender ? [last.sender] : undefined}
                getSummaryText={() => summaryText}
                layout={ctx.effectiveLayout}
            >
                {events.map((event) => (
                    <li key={event.getId()}>{renderTimelineItem(groupedEvent(event), ctx)}</li>
                ))}
            </GenericEventListSummary>
        </Fragment>
    );
}

/**
 * Draws one timeline row. Kept outside the component so it isn't redefined per render.
 *
 * @param tileAs - the element of an event's tile: a `div` in a row of its own, or an `li` in a list inside a row
 */
function renderTimelineItem(item: TimelineItem, ctx: RenderItemContext, tileAs: "div" | "li" = "div"): ReactNode {
    switch (item.kind) {
        case "date-separator":
            // The same view model as the old timeline, so the label and
            // jump-to-date menu behave identically in both.
            return (
                <DateSeparatorWrapper
                    key={item.key}
                    roomId={ctx.roomId}
                    ts={item.ts}
                    // Styled as the old timeline's separators are, such as in the desktop shell.
                    className="mx_TimelineSeparator"
                />
            );
        case "read-marker":
            // Rendered as a div because the timeline already puts each row in
            // its own list item.
            return (
                <ReadMarker
                    key={item.key}
                    eventId={item.key}
                    kind="current"
                    as="div"
                    label={_t("timeline|read_marker_new")}
                />
            );
        case "loading":
            return (
                <div key={item.key} className="mx_NewTimelinePanel_loading">
                    <InlineSpinner size={32} aria-label={_t("common|loading")} role="progressbar" />
                </div>
            );
        // Nothing produces gap rows yet. The old timeline draws nothing for a break in
        // history either, so until there is a design for one, neither do we.
        case "gap":
            return null;
        case "event-group": {
            const events = item.events as MatrixEvent[];
            if (item.variant === "creation") return renderCreation(item.key, events, ctx);
            if (item.variant === "gallery") {
                // Pictures after the first continue it, as the old timeline draws them when the rows do not say.
                const rows =
                    item.rows ?? events.map((event, index) => groupedEvent(event, true, index === events.length - 1));
                return renderGallery(item.key, rows, ctx);
            }
            // Always a fragment, so the summary keeps its state when the start of the room is reached.
            return (
                <Fragment key={item.key}>
                    {/* As in the old timeline, say why there is nothing earlier to see. */}
                    {item.startsHistory ? <HistoryTile key="history" /> : null}
                    <EventListSummary
                        key="summary"
                        as="div"
                        events={events}
                        layout={ctx.effectiveLayout}
                        // The tiles inside change with the rest of the timeline, such as which is the newest.
                        updateChildren
                    >
                        {(item.rows ?? events.map((event) => groupedEvent(event))).map((row) => (
                            // Each as it would be drawn on its own, as MessagePanel draws every tile: continuing the
                            // message before it, or still being sent, such as messages a module sums up.
                            <li key={tileKeyOf(row)}>{renderTimelineItem(row, ctx)}</li>
                        ))}
                    </EventListSummary>
                </Fragment>
            );
        }
        case "event": {
            const mxEvent = item.event as MatrixEvent;

            // For now, all events go through the legacy adapter.
            // As tiles are migrated to MVVM, this switch will
            // send migrated types to their shared views instead.
            return (
                <LegacyEventTileAdapter
                    key={tileKeyOf(item)}
                    as={tileAs}
                    mxEvent={mxEvent}
                    // A removed message keeps its identity, and the tile redraws only when what it is given changes,
                    // so it is told as MessagePanel tells it.
                    isRedacted={mxEvent.isRedacted()}
                    continuation={item.continuation}
                    lastInSection={item.lastInSection}
                    lastSuccessful={item.key === ctx.lastSuccessfulEventId}
                    last={item.key === ctx.lastEventId}
                    layout={ctx.effectiveLayout}
                    hideSender={ctx.hideSender}
                    isSelectedEvent={ctx.highlightedId !== null && item.key === ctx.highlightedId}
                    // A tile treats any edit state it is given as its own, so
                    // only the message being edited may receive it.
                    editState={ctx.editState?.getEvent().getId() === item.key ? ctx.editState : undefined}
                    sendState={item.sendState}
                    readReceipts={ctx.readReceiptsByEvent.get(item.key)}
                    readReceiptMap={ctx.readReceiptMap}
                    showReadReceipts={ctx.showReadReceipts}
                    getRelationsForEvent={ctx.getRelationsForEvent}
                    permalinkCreator={ctx.permalinkCreator}
                    showUrlPreview={ctx.showUrlPreview}
                    showReactions={ctx.showReactions}
                    isTwelveHour={ctx.isTwelveHour}
                    alwaysShowTimestamps={ctx.alwaysShowTimestamps}
                />
            );
        }
        default:
            return null;
    }
}

/**
 * The controls a room view uses on a timeline, for shortcuts, sending and editing, acting on `vm`.
 * @param vm - The timeline's view model.
 * @param scroller - Finds the timeline's scroller, for the keys that scroll it.
 */
export function roomMessagePanelFor(vm: RoomTimelineViewModel, scroller: () => HTMLElement | null): RoomMessagePanel {
    return {
        isAtEndOfLiveTimeline: () => vm.isAtLiveBottom,
        // Like the old timeline: the SDK may replace the live timeline while the reader is at its end. The view
        // model follows on to the new one, or keeps a reader of older messages where they are.
        canResetTimeline: () => vm.isAtLiveBottom,
        canJumpToReadMarker: () => vm.canJumpToReadMarker,
        jumpToLiveTimeline: () => vm.jumpToLive(),
        jumpToReadMarker: () => vm.jumpToReadMarker(),
        forgetReadMarker: () => vm.onMarkAllAsRead(),
        scrollToEventIfNeeded: (eventId?: string) => {
            if (eventId) vm.scrollToEventIfNeeded(eventId);
        },
        handleScrollKey: (ev) => {
            const element = scroller();
            if (!element) return;
            switch (getKeyBindingsManager().getRoomAction(ev)) {
                case KeyBindingAction.ScrollUp:
                    element.scrollBy({ top: -element.clientHeight * PAGE_SCROLL_FRACTION });
                    break;
                case KeyBindingAction.ScrollDown:
                    element.scrollBy({ top: element.clientHeight * PAGE_SCROLL_FRACTION });
                    break;
                case KeyBindingAction.JumpToFirstMessage:
                    // Reaching the top loads older history, as scrolling there does.
                    element.scrollTo({ top: 0 });
                    break;
                case KeyBindingAction.JumpToLatestMessage:
                    vm.jumpToLive();
                    break;
            }
        },
        sendReadReceipts: () => vm.sendReadReceiptNow(),
        // The fully read marker moves on now. The unread line drawn for this visit stays where it is.
        updateReadMarker: () => vm.moveReadMarkerOnNow(),
    };
}

/**
 * Draws a room's timeline from a view model it is given: the shared TimelineView with the room's tiles, summaries and
 * galleries. It neither starts nor disposes the view model; whoever made it does, such as {@link NewTimelinePanel}.
 */
export function NewTimelineRenderer({
    vm,
    room,
    highlightedEventId,
    layout,
    hidden,
    permalinkCreator,
    showUrlPreview,
    showReactions,
    editState,
    showReadReceipts = true,
    panelRef,
    eventScrollIntoView,
    onEventScrolledIntoView,
    execution,
}: Readonly<NewTimelineRendererProps & { vm: RoomTimelineViewModel }>): JSX.Element {
    const client: MatrixClient = useMatrixClientContext();
    const containerRef = useRef<HTMLDivElement>(null);
    const [entryPainted, setEntryPainted] = useState(false);
    const onItemsPainted = useCallback(
        (items: TimelineItem[]): void => {
            if (hidden) return;
            if (
                items.some((item) => {
                    if (item.kind !== "event") return false;
                    const event = item.event as MatrixEvent;
                    return event.getType() === EventType.RoomMessage && !event.isRedacted();
                })
            ) {
                markRoomSwitch("painted", room.roomId);
                notifyRoomEntryReady(client, room.roomId);
                setEntryPainted(true);
            }
        },
        [client, room, hidden],
    );

    // Read here rather than passed in, so changing either setting redraws the tiles.
    const isTwelveHour = useSettingValue("showTwelveHourTimestamps");
    const alwaysShowTimestamps = useSettingValue("alwaysShowTimestamps");

    const effectiveLayout = layout ?? Layout.Group;
    const irc = effectiveLayout === Layout.IRC;
    // Counted as the old timeline counts it, invited people included, and kept up to date as people come and go.
    const memberCount = useRoomMemberCount(room, { throttleWait: 250, includeInvited: true });
    const hideSender = effectiveLayout === Layout.Bubble && memberCount <= 2;

    // The highlighted message the panel opens with is the view model's starting point. Later navigations, from
    // permalinks, replies, pinned messages or search in the room already open, are shown in place.
    const lastNavigation = useRef({ eventId: highlightedEventId, scrollIntoView: eventScrollIntoView });
    useEffect(() => {
        const previous = lastNavigation.current;
        lastNavigation.current = { eventId: highlightedEventId, scrollIntoView: eventScrollIntoView };
        if (!highlightedEventId || eventScrollIntoView === false) return;
        if (highlightedEventId !== previous.eventId || previous.scrollIntoView === false) {
            vm.showEvent(highlightedEventId);
        }
        onEventScrolledIntoView?.(highlightedEventId);
    }, [vm, highlightedEventId, eventScrollIntoView, onEventScrolledIntoView]);

    useImperativeHandle(
        panelRef,
        (): RoomMessagePanel =>
            roomMessagePanelFor(
                vm,
                () => containerRef.current?.querySelector<HTMLElement>("[data-testid='timeline-scroller']") ?? null,
            ),
        [vm],
    );

    // The setting can change while the room is open.
    useEffect(() => {
        vm.setShowReadReceipts(showReadReceipts);
    }, [vm, showReadReceipts]);

    useEffect(() => {
        // Load the syntax highlighter up front. Code blocks fetch it the first time
        // one is shown, and if that arrives late the block re-wraps after its row
        // has been measured and the timeline jumps. Loading it now means the
        // highlighting is ready before the first code block is drawn.
        void import("highlight.js");
    }, []);

    // How a tile finds the reactions and edits attached to its message. Without
    // this, no reactions are drawn at all.
    const getRelationsForEvent = useCallback(
        (eventId: string, relationType: RelationType | string, eventType: EventType | string): Relations | undefined =>
            room.getUnfilteredTimelineSet().relations?.getChildEventsForEvent(eventId, relationType, eventType),
        [room],
    );

    const snapshot = useViewModel(vm);
    const { highlightedEventId: highlightedId, readReceiptsByEvent, lastSuccessfulEventId } = snapshot;
    const lastEventId = useMemo(() => lastEventIdOf(snapshot.items), [snapshot.items]);

    // Where each user's receipt avatar was last drawn; see RenderItemContext. Lives as long as
    // the panel, which is recreated per room, just like MessagePanel's copy.
    const readReceiptMap = useRef<{ [userId: string]: IReadReceiptPosition }>({});

    const renderItem = useCallback(
        (item: TimelineItem): ReactNode =>
            renderTimelineItem(item, {
                roomId: room.roomId,
                highlightedId,
                effectiveLayout,
                hideSender,
                permalinkCreator,
                showUrlPreview,
                showReactions,
                showReadReceipts,
                readReceiptsByEvent,
                readReceiptMap: readReceiptMap.current,
                lastSuccessfulEventId,
                lastEventId,
                isTwelveHour,
                alwaysShowTimestamps,
                editState,
                getRelationsForEvent,
            }),
        [
            room.roomId,
            highlightedId,
            effectiveLayout,
            hideSender,
            permalinkCreator,
            showUrlPreview,
            showReactions,
            showReadReceipts,
            readReceiptsByEvent,
            lastSuccessfulEventId,
            lastEventId,
            isTwelveHour,
            alwaysShowTimestamps,
            editState,
            getRelationsForEvent,
        ],
    );

    return (
        <div
            ref={containerRef}
            className={classNames("mx_NewTimelinePanel mx_RoomView_messagePanel mx_RoomView_messageListWrapper", {
                mx_NewTimelinePanel_hidden: hidden,
                // Gives the tiles the name column's width, as the old timeline's message panel does.
                mx_IRCLayout: irc,
            })}
        >
            {/* The name column's drag handle, over the timeline as in the old one. */}
            {irc && <IRCTimelineProfileResizer minWidth={20} maxWidth={600} roomId={room.roomId} />}
            <TimelineView
                vm={vm}
                renderItem={renderItem}
                onItemsPainted={entryPainted ? undefined : onItemsPainted}
                paddingBlock={LIST_PADDING_PX}
                execution={execution}
            />
        </div>
    );
}
