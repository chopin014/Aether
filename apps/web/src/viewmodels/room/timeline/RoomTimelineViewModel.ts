/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import {
    TimelineWindow,
    ClientEvent,
    Method,
    Direction,
    RoomEvent,
    EventType,
    MatrixEventEvent,
    NotificationCountType,
    ReceiptType,
    RelationType,
    RoomStateEvent,
    M_BEACON_INFO,
    type EventTimeline,
    type EventTimelineSet,
    type IRoomTimelineData,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    type RoomState,
} from "matrix-js-sdk/src/matrix";
import { BaseViewModel } from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";
import { KnownMembership } from "matrix-js-sdk/src/types";

import type {
    TimelineViewSnapshot,
    TimelineViewActions,
    TimelineItem,
    NavigationAnchor,
    ImmediateScroll,
} from "@element-hq/web-shared-components";
import { haveRendererForEvent, pickFactory } from "../../../events/EventTileFactory";
import shouldHideEvent from "../../../shouldHideEvent";
import SettingsStore from "../../../settings/SettingsStore";
import { SlidingSyncManager } from "../../../SlidingSyncManager";
import UserActivity from "../../../UserActivity";
import Timer from "../../../utils/Timer";
import { clearRoomNotification } from "../../../utils/notifications";
import { findLastSuccessfulWeSent } from "./event-tile/EventTileReceiptState";
import {
    getReadReceiptsByShownEvent,
    getReadReceiptsForEvent,
    reuseUnchangedReadReceipts,
    type ShownReadReceipt,
} from "../../../utils/read-receipts";
import type { IReadReceiptProps } from "../../../components/views/rooms/EventTile";
import { ModuleApi } from "../../../modules/Api";
import { GALLERY_WINDOW_MS, isGalleryMedia } from "../../../utils/gallery";
import { wantsDateSeparator } from "../../../DateUtils";
import { getLateEventInfo } from "../../../components/structures/grouper/LateEventGrouper";
import { sendStateOf } from "./sendState";

const DEBUG_TIMELINE = false;

/** State changes summed up with the events like them around them, as in the old timeline's `MainGrouper`. */
const SUMMARISED_STATE_TYPES: ReadonlySet<string> = new Set([
    EventType.RoomMember,
    EventType.RoomThirdPartyInvite,
    EventType.RoomServerAcl,
    EventType.RoomPinnedEvents,
]);

/** Emits a trace line only when {@link DEBUG_TIMELINE} is on. */
const debug = (message: string): void => {
    if (DEBUG_TIMELINE) logger.debug(message);
};

/** How long after the last scroll event to wait before sending a read receipt (ms). */
const READ_RECEIPT_DEBOUNCE_MS = 500;

const PAGINATE_SIZE = 100;
/** How long a fully read marker write may take before it is given up on; see {@link RoomTimelineViewModelOpts}. */
const READ_MARKER_WRITE_TIMEOUT_MS = 20_000;

/**
 * Settle as `promise` does, or fail once `ms` have passed without it settling, calling `onGiveUp` first. Only the
 * returned promise is waited on after that; `promise` keeps nothing but this function's own closures.
 */
function settleWithin<T>(promise: Promise<T>, ms: number, onGiveUp: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            onGiveUp();
            reject(new Error(`No complete answer within ${ms}ms`));
        }, ms);
        promise.then(
            (value) => {
                window.clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}
const INITIAL_SIZE = 100;

/**
 * Fill anchored loads before placing their target so a short list does not shift the reader.
 * Live loads can show cached messages immediately: the view bottom-aligns a short live list
 * while older messages arrive, keeping the newest message in place.
 */
const MIN_INITIAL_EVENTS = 40;

/**
 * The most messages we keep loaded at once. Loading more than this makes the SDK drop an
 * equivalent number from the far end, so memory stays bounded however long someone scrolls.
 *
 * We set this explicitly rather than take the SDK's default so we know the exact number, which
 * lets {@link RoomTimelineViewModel.makeRoomBeforeExtending} see a drop coming and do it as a
 * separate step instead of letting it happen in the middle of adding new messages.
 */
const WINDOW_LIMIT = 1000;

/**
 * Maximum time {@link RoomTimelineViewModel.waitForDecryption} blocks the
 * paginate chain on newly-fetched events. Decryption usually completes in
 * tens of milliseconds; this cap stops a slow/failed decryption from holding
 * the loading spinner indefinitely. Anything slower than this is not lost: it appears shortly
 * after it does decrypt, via {@link RoomTimelineViewModel.onEventDecrypted} — the reader does
 * not have to scroll or wait for another message to prompt it.
 */
const PAGINATE_DECRYPT_WAIT_MS = 500;

/**
 * Discriminated union describing the initial scroll target for {@link RoomTimelineViewModel.load}.
 *
 * - `live`      — scroll to the live end of the room. With `keepHighlight`, a highlighted message still in the
 *                 window stays highlighted.
 * - `permalink` — centre on `eventId` and highlight it.
 * - `restore`   — scroll to the saved `eventId` without highlighting.
 */
type LoadTarget =
    | { kind: "live"; keepHighlight?: boolean }
    | { kind: "permalink"; eventId: string; toReadMarker?: boolean }
    | { kind: "restore"; eventId: string };

/**
 * What the room timeline publishes to its view: the shared snapshot, plus the per-message detail
 * the legacy tiles need and the shared view has no opinion about.
 */
export interface RoomTimelineViewSnapshot extends TimelineViewSnapshot {
    /**
     * Other users' read receipts, keyed by the id of the message they are drawn beside. A receipt
     * for an event that is not shown (a reaction, a membership change) is drawn beside the last
     * shown message before it. Empty while read receipts are turned off.
     */
    readReceiptsByEvent: ReadonlyMap<string, IReadReceiptProps[]>;
    /**
     * The newest message of ours that has reached the server, when it is also the newest message
     * that could carry a receipt — the one tile that shows a "Sent" tick in place of read
     * receipts. Mirrors `lastSuccessfulWeSent` in the old MessagePanel.
     */
    lastSuccessfulEventId: string | null;
}

export interface RoomTimelineViewModelOpts {
    client: MatrixClient;
    room: Room;
    /** Optional anchor for initial load (permalink, search result). Shown highlighted and centred. */
    initialEventId?: string;
    /** Whether other users' read receipts are drawn; see {@link RoomTimelineViewModel.setShowReadReceipts}. Default true. */
    showReadReceipts?: boolean;
    /**
     * Whether what each load shows is read as soon as it is placed, without waiting for the reader to be active, as
     * the old timeline does when the reader opened the room themselves. Default false.
     */
    sendReadReceiptOnLoad?: boolean;
    /**
     * Whether read receipts and the fully read marker move on by themselves while the reader is active, as in the old
     * timeline. A room view a module embeds can turn this off, so that they move only when it is focused, through
     * {@link RoomTimelineViewModel.sendReadReceiptNow} and {@link RoomTimelineViewModel.moveReadMarkerOnNow}. Default
     * true.
     */
    enableReadReceiptsAndMarkersOnActivity?: boolean;
    /**
     * How long a write of the fully read marker may wait for the server to start answering: 20 seconds by default.
     * The whole write, its answer included, is given up on as failed after twice that; see
     * {@link RoomTimelineViewModel.sendReadMarker}.
     */
    readMarkerWriteTimeoutMs?: number;
}

/**
 * Works out what the room timeline should show, and keeps it up to date.
 *
 * The shared `TimelineView` draws a list and reports what the user can see; it knows nothing
 * about Matrix. This class is the other half: it owns all the Matrix detail and hands the view
 * a plain list of rows to render. Everything travels in one direction each way — we publish a
 * snapshot (the rows, plus flags like "are we at the newest message"), and the view calls back
 * to say what happened ("the top is showing", "the user is at the bottom").
 *
 * The messages themselves come from the SDK's `TimelineWindow`, a sliding window over the room's
 * history. It holds at most {@link WINDOW_LIMIT} messages: paginating past that drops an equal
 * number off the far end, so scrolling for a long time does not grow memory without limit.
 *
 * What this class has to get right:
 *
 *  - **Turning events into rows.** Not every event is shown (hidden or unrenderable types are
 *    skipped), and some rows are not events at all — date separators, the unread marker, and
 *    the loading spinners at either end. See `buildItems`.
 *  - **Loading more when asked.** The view reports reaching either end; we fetch more history
 *    in that direction, showing a spinner while it happens.
 *  - **Where to start.** Usually the newest message, but a permalink starts at a specific
 *    message, and returning to a room restores where the reader left off. See `LoadTarget`.
 *  - **Read state.** Tracking the unread marker, deciding whether to offer a jump to it, and
 *    sending read receipts as the reader catches up.
 *  - **Messages being sent.** Drawn from the room's pending list until the server echoes them,
 *    with the row's `sendState` saying how far each has got. See `pendingEventsToShow` and
 *    `onLocalEchoUpdated`.
 *
 * A note on timing: the constructor deliberately does nothing but set fields. React's StrictMode
 * builds two instances in development and discards one, so anything that subscribes or fetches
 * belongs in {@link start}, which the view calls exactly once.
 */
export class RoomTimelineViewModel
    extends BaseViewModel<RoomTimelineViewSnapshot, RoomTimelineViewModelOpts>
    implements TimelineViewActions
{
    private readonly opts: RoomTimelineViewModelOpts;
    private timelineWindow: TimelineWindow;

    /** Whether other users' read receipts are drawn; see {@link setShowReadReceipts}. */
    private showReadReceipts: boolean;

    /**
     * Where each user's receipt was last drawn, so a receipt that moves onto an event we do not
     * hold stays where it was; see {@link getReadReceiptsByShownEvent}.
     */
    private receiptsByUserId: Map<string, ShownReadReceipt> = new Map();

    /**
     * Cache of continuation decisions keyed by event id.
     *
     * Whether a message is a "continuation" — drawn without repeating the sender's avatar and
     * name — depends on the message immediately before it. That is a problem when older history
     * loads in: the message that used to be first suddenly has something before it, and can flip
     * to being a continuation. Losing its avatar and name makes the row shorter, which drags
     * everything below it upwards and moves the text the reader was looking at.
     *
     * So we decide each message's continuation status the first time we see it and never revisit
     * it. The cost is an occasional repeated avatar where two loaded batches meet, which is far
     * less annoying than the text moving while you read it.
     */
    private continuationCache = new Map<string, boolean>();

    /** Set by {@link start} so a double-start (e.g. via StrictMode) is a no-op. */
    private started = false;

    /** Set while a rebuild is queued for the next microtask; see {@link scheduleRebuild}. */
    private rebuildQueued = false;
    /** Set when a rebuild was asked for while a load ran, so it still happens if the load ends without building. */
    private rebuildAfterLoad = false;
    /** Whether the reader is going to the unread line, which has a row whatever its event is grouped in. */
    private navigationToReadMarker = false;
    /** Whether the view has placed the reader since the window was last loaded, so rows shown are being read. */
    private readerPlaced = false;
    /** The start of the room as summed up: its create event and the events in the summary, fixed once shown. */
    private creationGroup?: { createId: string; ids: Set<string> };
    /** The start of a room left in rows of their own for this visit, such as one the reader was taken into. */
    private creationDeclined?: string;

    /** Set while a {@link load} is running; see {@link scheduleRebuild}. */
    private loading = false;

    /** Counts {@link load} calls, so a load overtaken by a newer one does not publish its stale window. */
    private loadGeneration = 0;

    /**
     * Runs while the user is active, to send the read receipt held back while they were away; see
     * {@link sendAutoReadReceipt}.
     */
    private receiptActivityTimer?: Timer;
    /** Counts the reader's time around before the fully read marker moves on; see {@link moveReadMarkerOnWhileActive}. */
    private readMarkerTimer?: Timer;

    /** Avoid racing native initial history expansion with a separate messages request. */
    private initialTimelinePending = false;
    private backwardAfterInitialTimeline = false;

    /**
     * In-flight backward pagination chain, or null when idle.
     *
     * A single `Promise<void>` is created for the first `onStartReached` call.
     * Any further `onStartReached` calls while the chain is running set
     * {@link backwardRerunRequested} instead of starting a parallel chain.
     * When the chain settles this is set back to null (running one follow-up
     * chain if a request arrived meanwhile), and the next `onStartReached`
     * creates a fresh chain.
     *
     * Using a stored promise as the guard ensures coalescing survives the async
     * gap between when the chain finishes and when the next `onStartReached` fires.
     */
    private backwardPaginateChain: Promise<void> | null = null;

    /** Mirror of {@link backwardPaginateChain} for the forward direction. */
    private forwardPaginateChain: Promise<void> | null = null;

    /**
     * Set when the view asks for more history while a fetch is already running, and
     * acted on by running one more fetch once that one finishes.
     *
     * Coalescing must not *lose* the request: the view de-duplicates edge reports, and its
     * dedup key can collide across a chain boundary (observed: the spinner row's removal
     * exactly cancelling out one new event, leaving the same item count at the same scroll
     * index). When that happens the view never re-fires, and without this flag the timeline
     * sits stalled at the edge with more history available until the user jiggles the scroll.
     */
    private backwardRerunRequested = false;

    /** Mirror of {@link backwardRerunRequested} for the forward direction. */
    private forwardRerunRequested = false;

    /**
     * Whether the view shows the start of the loaded messages: from {@link onStartReached} until {@link onStartLeft},
     * or until the reader is taken elsewhere. History added there meanwhile, such as sliding sync brings for a room
     * restored from this device, is paged in as it comes, as the old timeline's fill check does: the view does not
     * report the start again while the reader stays at it.
     */
    private startInView = false;

    /**
     * The real timeline content: messages, date separators and the unread marker, with no
     * loading spinners. {@link republish} adds the spinners on the way out to the view, so
     * showing or hiding one never has to touch this list.
     */
    private baseItems: TimelineItem[] = [];

    /** Keep a summary's identity when history is added on either side. */
    private readonly summaryGroupKeys = new WeakMap<MatrixEvent, string>();
    private summaryGroupSequence = 0;
    /** Keep a gallery's identity as pictures join or leave it at either end; see {@link groupGalleries}. */
    private readonly galleryGroupKeys = new WeakMap<MatrixEvent, string>();
    private galleryGroupSequence = 0;

    /** A permalink or saved position must remain an individually addressable event row. */
    private navigationEventId: string | null = null;

    /** Whether the leading (backward) pagination spinner is currently shown. */
    private backwardSpinnerVisible = false;

    /** Whether the trailing (forward) pagination spinner is currently shown. */
    private forwardSpinnerVisible = false;

    /** The event ID for which we last sent a read receipt, to avoid redundant sends. */
    private lastSentReceiptEventId: string | null = null;

    /** Debounce timer for auto read receipt sends triggered by scroll. */
    private readReceiptDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    /** See {@link RoomTimelineViewModelOpts.sendReadReceiptOnLoad} and {@link setSendReadReceiptOnLoad}. */
    private sendReadReceiptOnLoad: boolean;
    /** Set when a load finishes, so the first range seen once it is placed is read; see `sendReadReceiptOnLoad`. */
    private receiptOnPlacement = false;
    /** See {@link RoomTimelineViewModelOpts.enableReadReceiptsAndMarkersOnActivity}. */
    private readonly readStateOnActivity: boolean;
    /** The newest message that came into view while the reader was active, until it is read; see {@link scheduleReadReceipt}. */
    private seenWhileActiveEventId: string | null = null;

    /**
     * Debouncer for items rebuilds after a burst of Decrypted events.
     * See {@link onEventDecrypted} / {@link flushDecryptRebuild}.
     */
    private decryptDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly DECRYPT_FLUSH_DEBOUNCE_MS = 200;

    /** True when the view reports the list is scrolled to the bottom. */
    private isAtBottom = false;

    /**
     * The event ID of the bottommost visible item as last reported by
     * {@link onVisibleRangeChanged}. Persisted to localStorage on dispose
     * so the view can be restored to this position next visit.
     */
    private lastBottomEventId: string | null = null;

    /**
     * The message a read receipt is sent for: the bottommost visible confirmed message from someone else, as the old
     * timeline reads up to, or the bottommost of ours when there is none. See {@link receiptTargetOf}.
     */
    private lastReceiptTargetId: string | null = null;

    /**
     * Our receipt on the server, as last seen. The room can lose track of it after a gap in sync, once the event it is
     * on leaves the room's timelines, while the window kept from before still holds that event. See
     * {@link serverReceiptEventId}.
     */
    private knownServerReceiptId: string | null = null;

    /**
     * The 0-based index (into the items array) of the topmost currently-visible item.
     * Updated on every `onVisibleRangeChanged` call; used to derive `canJumpToReadMarker`.
     */
    private visibleStartArrayIndex = 0;

    /**
     * The 0-based index (into the items array) of the bottommost currently-visible item.
     * Updated on every `onVisibleRangeChanged` call; used to derive `canJumpToReadMarker`.
     */
    private visibleEndArrayIndex = 0;

    /**
     * The Matrix event ID of the room's "fully read" marker. null when none is set.
     * Tracked via `RoomEvent.AccountData` / `EventType.FullyRead`. Reflects server
     * state and may change mid-session if another device advances the marker, or when we
     * move it on ({@link moveReadMarkerOn}); used by {@link onMarkAllAsRead}
     * but NOT by the UI.
     */
    private readMarkerEventId: string | null = null;

    /**
     * Where the unread line sits, decided once when the room is opened and then left alone for
     * as long as the reader stays in it. Set by {@link freezeReadMarkerForSession}, and read by
     * {@link buildItems}, {@link computeCanJumpToReadMarker} and {@link onJumpToReadMarker}.
     *
     * `null` means no line at all this visit — either the room was already read on entry, or
     * there is no marker. Otherwise the line stays pinned to that message however much the
     * reader scrolls, sends, or receives.
     *
     * Holding it still is deliberate, and matches Element X: a line that crept downwards
     * as you read would take away the very thing you are using it for — seeing where you got to.
     * The server-side marker moves on as the reader reads (see {@link moveReadMarkerOn}), so
     * the line moves when the room is left and re-entered, or immediately if the reader marks
     * everything read ({@link onMarkAllAsRead}).
     */
    private frozenMarkerEventId: string | null = null;
    /** Whether {@link frozenMarkerEventId} has been decided for this visit; later loads leave it alone. */
    private readMarkerFrozen = false;
    /**
     * Whether the room's own fully read marker has yet to come from the server. Until it does, the line starts from the
     * reader's receipt; see {@link onRoomAccountData}.
     */
    private awaitingServerReadMarker = false;
    /** The events this visit moved the marker to, to know the server's echoes of them; see {@link writeReadMarker}. */
    private readonly sentReadMarkerIds = new Set<string>();

    /**
     * Each room's fully read marker writes, in order, across view models, so a write made before the reader left a room
     * cannot land after one made since they came back. Keyed by the room object, which the client keeps for as long as
     * it knows the room. `written` is the last marker the server took there: nothing is written behind it, and it
     * raises the next view model's own marker.
     */
    private static readonly readMarkerWrites = new WeakMap<Room, { queue: Promise<void>; written?: string }>();

    /**
     * Count of new live messages that arrived since the user last reached the
     * visual bottom of the live timeline. Reset on `onAtBottomStateChange(true)`
     * when `atLiveEnd` is also true.
     */
    private unreadMessageCount = 0;

    private static readonly SCROLL_STATE_KEY_PREFIX = "timeline_scroll_";

    private static readScrollTarget(roomId: string): string | null {
        try {
            return localStorage.getItem(`${RoomTimelineViewModel.SCROLL_STATE_KEY_PREFIX}${roomId}`);
        } catch {
            return null;
        }
    }

    private static saveScrollTarget(roomId: string, eventId: string | null): void {
        try {
            if (eventId) {
                localStorage.setItem(`${RoomTimelineViewModel.SCROLL_STATE_KEY_PREFIX}${roomId}`, eventId);
            } else {
                localStorage.removeItem(`${RoomTimelineViewModel.SCROLL_STATE_KEY_PREFIX}${roomId}`);
            }
        } catch {
            // Ignore storage errors (private browsing, quota exceeded, etc.)
        }
    }

    public constructor(opts: RoomTimelineViewModelOpts) {
        super(opts, {
            items: [],
            atLiveEnd: false,
            pendingAnchor: null,
            highlightedEventId: opts.initialEventId ?? null,
            isAtBottom: false,
            canJumpToReadMarker: false,
            numUnreadMessages: 0,
            hasHighlights: false,
            readReceiptsByEvent: new Map(),
            lastSuccessfulEventId: null,
        });

        this.opts = opts;
        this.showReadReceipts = opts.showReadReceipts ?? true;
        this.sendReadReceiptOnLoad = opts.sendReadReceiptOnLoad ?? false;
        this.readStateOnActivity = opts.enableReadReceiptsAndMarkersOnActivity ?? true;
        this.timelineWindow = new TimelineWindow(opts.client, opts.room.getUnfilteredTimelineSet(), {
            windowLimit: WINDOW_LIMIT,
        });

        // Initialise the read marker from room account data.
        const fullyRead =
            (opts.room.getAccountData(EventType.FullyRead)?.getContent()?.event_id as string | undefined) ?? null;
        // As the old timeline does, a room without a marker yet is read up to the reader's receipt, which the SDK
        // also gives for the reader's own messages.
        this.readMarkerEventId = fullyRead ?? opts.room.getEventReadUpTo(opts.client.getSafeUserId());
        this.awaitingServerReadMarker = fullyRead === null;

        // NOTE: deliberately side-effect-free. React StrictMode (and useState
        // initializer checks) invoke `vmCreator` twice in dev, constructing
        // two instances; one is retained, one is discarded. If we registered
        // listeners or kicked off load() here, the discarded instance would
        // silently leak its subscriptions. Side effects belong in {@link start}
        // which the View calls exactly once via useEffect.
    }

    /**
     * Wire the VM up to its data sources and kick off the initial load.
     *
     * Must be called exactly once per instance, after construction, from a
     * React effect (so React's lifecycle controls when subscriptions attach).
     * Calling this from the constructor risks leaking listeners on
     * StrictMode-discarded instances; see the constructor comment.
     */
    public start(): void {
        // In StrictMode dev, a consumer's useEffect can briefly fire with a
        // stale `vm` reference between the hook disposing the old VM and
        // React re-rendering with the new one. That's harmless — we just bail.
        if (this.started || this.isDisposed) return;
        this.started = true;

        // Determine how to load the timeline.
        let loadTarget: LoadTarget;
        if (this.opts.initialEventId) {
            loadTarget = { kind: "permalink", eventId: this.opts.initialEventId };
        } else {
            const savedEventId = RoomTimelineViewModel.readScrollTarget(this.opts.room.roomId);
            loadTarget = savedEventId ? { kind: "restore", eventId: savedEventId } : { kind: "live" };
        }

        void this.loadInitialTimeline(loadTarget);

        // Listen for new events so live messages appear.
        this.disposables.trackListener(
            this.opts.room,
            RoomEvent.Timeline,
            this.onRoomTimeline as (...args: unknown[]) => void,
        );
        // Track changes to the room's fully-read marker.
        this.disposables.trackListener(
            this.opts.room,
            RoomEvent.AccountData,
            this.onRoomAccountData as (...args: unknown[]) => void,
        );
        // Decryption arrivals (late key delivery / key backup) need a rebuild
        // so previously-pending events that we filtered out of items become
        // visible. RoomEvent.Timeline only fires once per event at arrival
        // time and is not re-emitted on decryption (see js-sdk
        // event-timeline-set.js addEventToTimeline → emit Timeline), so this
        // listener is the only signal we have for that transition.
        this.disposables.trackListener(
            this.opts.client,
            MatrixEventEvent.Decrypted,
            this.onEventDecrypted as (...args: unknown[]) => void,
        );
        // Messages of ours changing send state or getting their server id.
        this.disposables.trackListener(
            this.opts.room,
            RoomEvent.LocalEchoUpdated,
            this.onLocalEchoUpdated as (...args: unknown[]) => void,
        );
        // Other users' read receipts moving.
        this.disposables.trackListener(this.opts.room, RoomEvent.Receipt, this.onRoomReceipt);
        this.serverReceiptEventId();
        // Messages removed, or their removal undone, which changes whether and how their rows are drawn. A removal
        // the server sends also arrives as a timeline event, but one applied here, such as by a retention policy, and
        // a cancelled one do not.
        this.disposables.trackListener(
            this.opts.room,
            RoomEvent.Redaction,
            this.onRoomRedaction as (...args: unknown[]) => void,
        );
        this.disposables.trackListener(
            this.opts.room,
            RoomEvent.RedactionCancelled,
            this.onRoomRedaction as (...args: unknown[]) => void,
        );
        // The SDK starting a new live timeline after a gap in sync. The room re-emits it from its timeline sets.
        this.disposables.trackListener(
            this.opts.room,
            RoomEvent.TimelineReset,
            this.onTimelineReset as (...args: unknown[]) => void,
        );
        // Members loading or changing profile, whose receipts carry their avatar and name. Listened
        // for on the client, which re-emits it for whichever state object the room currently has.
        this.disposables.trackListener(
            this.opts.client,
            RoomStateEvent.Update,
            this.onRoomStateUpdate as (...args: unknown[]) => void,
        );
        // Which events have rows depends on whether hidden events are shown, and on who is ignored: draw the rows
        // again when either changes, as the old timeline does.
        const hiddenEventsWatcher = SettingsStore.watchSetting("showHiddenEventsInTimeline", null, () =>
            this.scheduleRebuild(),
        );
        this.disposables.track(() => SettingsStore.unwatchSetting(hiddenEventsWatcher));
        this.disposables.trackListener(
            this.opts.client,
            ClientEvent.AccountData,
            this.onClientAccountData as (...args: unknown[]) => void,
        );
        if (this.readStateOnActivity) void this.moveReadMarkerOnWhileActive();
    }

    /**
     * Move the room's fully read marker on to what the reader has seen while they are around, as `TimelinePanel`
     * does: after a few seconds with the marker on screen, or longer with it off screen, each time the reader has
     * been active recently. The unread line drawn for this visit stays where it is; see {@link frozenMarkerEventId}.
     */
    private async moveReadMarkerOnWhileActive(): Promise<void> {
        const timer = new Timer(this.readMarkerTimeout());
        this.readMarkerTimer = timer;
        while (this.readMarkerTimer === timer && !this.isDisposed) {
            UserActivity.sharedInstance().timeWhileActiveRecently(timer);
            try {
                await timer.finished();
            } catch {
                // The reader went away before the time was up: wait for them again.
                continue;
            }
            if (this.readMarkerTimer !== timer || this.isDisposed) return;
            // One write at a time, as in the old timeline, so two cannot reach the server out of order and move the
            // marker back. The next one is decided afresh once this one is done.
            await this.moveReadMarkerOn();
        }
    }

    /** How long the reader has to be around first: shorter while the fully read marker is on screen. */
    private readMarkerTimeout(): number {
        return this.readMarkerPosition() === 0
            ? (SettingsStore.getValue("readMarkerInViewThresholdMs") ?? 3000)
            : (SettingsStore.getValue("readMarkerOutOfViewThresholdMs") ?? 30000);
    }

    /**
     * Where the room's fully read marker is against what the reader can see: above (-1), on screen (0) or below (1),
     * or null when that cannot be told.
     */
    private readMarkerPosition(): -1 | 0 | 1 | null {
        const markerId = this.readMarkerEventId;
        if (!markerId) return null;
        const events = this.timelineWindow.getEvents();
        const marker = events.findIndex((event) => event.getId() === markerId);
        const items = this.snapshot.current.items;
        const top = this.firstEventIndexOf(items.slice(this.visibleStartArrayIndex, this.visibleEndArrayIndex + 1));
        const bottom = this.lastBottomEventId
            ? events.findIndex((event) => event.getId() === this.lastBottomEventId)
            : -1;
        if (marker >= 0 && top >= 0 && bottom >= 0) {
            if (marker < top) return -1;
            return marker > bottom ? 1 : 0;
        }
        // Not in the window: older or newer than all of it.
        const markerEvent = marker >= 0 ? events[marker] : this.opts.room.findEventById(markerId);
        if (!markerEvent || events.length === 0) return null;
        return markerEvent.getTs() < events[0].getTs() ? -1 : 1;
    }

    /** The window position of the first real event among `items`, or -1. */
    private firstEventIndexOf(items: readonly TimelineItem[]): number {
        const events = this.timelineWindow.getEvents();
        for (const item of items) {
            const first = this.itemEvents(item)[0];
            if (first) return events.indexOf(first);
        }
        return -1;
    }

    /**
     * Whether read receipts and the fully read marker may be sent. Someone previewing a room they have not joined
     * cannot send them there, and, as in the old timeline, nothing is sent in low-bandwidth mode or by a guest.
     */
    private maySendReadState(): boolean {
        return (
            !this.isDisposed &&
            this.opts.room.getMyMembership() === KnownMembership.Join &&
            !SettingsStore.getValue("lowBandwidth") &&
            !this.opts.client.isGuest()
        );
    }

    /** Move the fully read marker on to the bottommost message the reader sees, never back. */
    private async moveReadMarkerOn(): Promise<void> {
        if (!this.maySendReadState()) return;
        // While a window loads or is placed, what was last on screen belongs to the window before it.
        if (this.loading || !this.readerPlaced || this.snapshot.current.pendingAnchor !== null) return;
        const eventId = this.lastBottomEventId;
        // A marker at or below that message is ahead of what the reader is looking at: leave it.
        if (!eventId || !this.comesAfter(eventId, this.readMarkerEventId)) return;
        await this.writeReadMarker(eventId);
    }

    /**
     * Move the room's fully read marker to `eventId` when it comes after the marker, once the writes before it for this
     * room are done, as the old timeline sends one at a time. It is decided again then, against the last marker any
     * view of the room wrote, so it never moves back. A write that takes too long is aborted and given up on, so it
     * holds up no later one, and this client never sends it after one. A failed write is tried again by whoever moves
     * the marker next.
     */
    private writeReadMarker(eventId: string): Promise<void> {
        const room = this.opts.room;
        const writes = RoomTimelineViewModel.readMarkerWrites;
        const state = writes.get(room) ?? { queue: Promise.resolve() };
        writes.set(room, state);
        const write = state.queue.then(async (): Promise<void> => {
            if (state.written && this.comesAfter(state.written, this.readMarkerEventId)) {
                this.readMarkerEventId = state.written;
            }
            if (!this.maySendReadState() || !this.comesAfter(eventId, this.readMarkerEventId)) return;
            // Past the last marker written here too, whatever this view knows of it: one that cannot be placed against
            // it, such as in history it is no longer among, is left for later.
            if (state.written && !this.comesAfter(eventId, state.written)) return;
            debug(`[TimelineVM] writeReadMarker — fully read marker to ${eventId}`);
            const previous = this.readMarkerEventId;
            this.readMarkerEventId = eventId;
            this.sentReadMarkerIds.add(eventId);
            try {
                await this.sendReadMarker(eventId);
                state.written = eventId;
            } catch (err) {
                logger.warn(`[TimelineVM] writeReadMarker — the fully read marker could not be written`, err);
                this.sentReadMarkerIds.delete(eventId);
                // Back to where the marker is known to be: the later of where it was, and where the server has said it
                // is since, such as when another device moved it on while this write was failing.
                if (this.readMarkerEventId === eventId) {
                    const fromServer = this.roomReadMarkerEventId();
                    this.readMarkerEventId =
                        fromServer && this.comesAfter(fromServer, previous) ? fromServer : previous;
                }
            }
        });
        state.queue = write;
        return write;
    }

    /**
     * Send the room's fully read marker, as the SDK's `setRoomReadMarkers` does, but through its HTTP API, which can
     * abort a request: one that takes too long is ended rather than left to be sent after later ones. A server that
     * received it before the abort may still take it; Synapse only ever moves the marker forward.
     */
    private sendReadMarker(eventId: string): Promise<unknown> {
        const timeoutMs = this.opts.readMarkerWriteTimeoutMs ?? READ_MARKER_WRITE_TIMEOUT_MS;
        const path = `/rooms/${encodeURIComponent(this.opts.room.roomId)}/read_markers`;
        // Ends the write for good once it is given up on, including the retry the HTTP API makes after refreshing an
        // expired access token, which would otherwise send it again after a later write.
        const abort = new AbortController();
        const request = this.opts.client.http.authedRequest(
            Method.Post,
            path,
            undefined,
            { [ReceiptType.FullyRead]: eventId },
            { localTimeoutMs: timeoutMs, abortSignal: abort.signal },
        );
        // The HTTP API stops timing a request once the server starts to answer, then reads the answer for as long as
        // it takes. An answer that never finishes is given up on as failed, rather than holding up this room's later
        // writes. Writing the same marker again is harmless.
        return settleWithin(request, timeoutMs * 2, () => abort.abort());
    }

    /** The room's fully read marker as the server last said, or null. */
    private roomReadMarkerEventId(): string | null {
        return (
            (this.opts.room.getAccountData(EventType.FullyRead)?.getContent()?.event_id as string | undefined) ?? null
        );
    }

    /**
     * Whether the event `eventId` comes after the event `otherId`, or there is no other. The window gives the order when
     * it holds both events, else the room's timelines (see {@link orderOf}). One neither can place is taken to be ahead
     * while the window can still page forward towards it, as the old timeline does with a receipt outside its window,
     * and while the window is kept from before a gap in sync, as its events can no longer be placed against the room's.
     * Times are not compared, as servers' clocks differ.
     */
    private comesAfter(eventId: string, otherId: string | null): boolean {
        if (!otherId) return true;
        const order = this.orderOf(otherId, eventId);
        if (order !== null) return order < 0;
        return !this.timelineWindow.canPaginate(Direction.Forward) && !this.windowDetachedFromLive();
    }

    /** Someone was ignored or no longer is: their messages leave or come back. */
    private onClientAccountData = (event: MatrixEvent): void => {
        if (event.getType() === EventType.IgnoredUserList) this.scheduleRebuild();
    };

    /**
     * Older messages were added at the start of one of the room's timelines. When that is where the window starts and
     * the reader is there to see them, page them in; see {@link startInView}. Anywhere else, paging would push the
     * messages being read out of the window. Messages paged in by the window itself come through here too, and are
     * left to it.
     */
    private onHistoryAddedAtStart(timeline: EventTimeline): void {
        if (this.isDisposed || this.backwardPaginateChain || !this.startInView) return;
        if (timeline !== this.timelineWindow.getTimelineIndex(Direction.Backward)?.timeline) return;
        debug(`[TimelineVM] onHistoryAddedAtStart — paging in history that arrived after the start was reached`);
        this.triggerBackwardPaginate();
    }

    /**
     * The SDK started a new live timeline because sync skipped messages. A reader at the newest messages follows on
     * to the new timeline; one reading older messages keeps their place, with the jump-to-latest button offered.
     */
    private onTimelineReset = (_room: Room | undefined, timelineSet: EventTimelineSet): void => {
        if (this.isDisposed || timelineSet !== this.opts.room.getUnfilteredTimelineSet()) return;
        const readingHistory = this.readingHistory;
        debug(`[TimelineVM] onTimelineReset — readingHistory=${readingHistory}`);
        if (!readingHistory) {
            void this.load({ kind: "live" });
            return;
        }
        // Regular sync may keep the old timeline with a token leading forward to the new one; otherwise the window
        // no longer reaches new messages until the live end is loaded again.
        this.mergeSnapshot({ atLiveEnd: this.windowReachesLive() }, "timeline-reset");
    };

    /**
     * Whether reloading the newest messages would take the reader away from where they are: a navigation still
     * loading or being placed, or older messages they navigated or scrolled to. A reader at the newest messages is
     * not, even after navigating somewhere and scrolling back down.
     */
    private get readingHistory(): boolean {
        const navigating =
            this.navigationEventId !== null && (this.loading || this.snapshot.current.pendingAnchor !== null);
        return (
            navigating || (!this.isAtLiveBottom && (this.navigationEventId !== null || this.lastBottomEventId !== null))
        );
    }

    /**
     * Whether the window ends in a timeline the SDK no longer leads to new messages from: one dropped when sync
     * replaced every timeline after a gap. Forward pagination cannot reach the live end from it.
     */
    private windowDetachedFromLive(): boolean {
        if (this.timelineWindow.canPaginate(Direction.Forward)) return false;
        const end = this.timelineWindow.getTimelineIndex(Direction.Forward)?.timeline;
        return end !== undefined && end !== this.opts.room.getUnfilteredTimelineSet().getLiveTimeline();
    }

    /**
     * Whether `window` may have older messages before it. The SDK keeps a token for them until a request for them comes
     * back empty, as after a reload, but nothing comes before the room's creation: a window that starts at
     * `m.room.create` holds the start of the room. Asking anyway would cost a request, keep the date at the start of
     * the room from showing until it came back, and leave a short room aligned to the bottom as if more were coming.
     */
    private hasOlderMessages(window: TimelineWindow = this.timelineWindow): boolean {
        return window.canPaginate(Direction.Backward) && window.getEvents()[0]?.getType() !== EventType.RoomCreate;
    }

    /** Whether `window` can be extended in `direction`; see {@link hasOlderMessages}. */
    private canExtend(window: TimelineWindow, direction: Direction): boolean {
        return direction === Direction.Backward ? this.hasOlderMessages(window) : window.canPaginate(Direction.Forward);
    }

    /** Whether the window holds the newest messages of the room's live timeline. */
    private windowReachesLive(): boolean {
        return !this.timelineWindow.canPaginate(Direction.Forward) && !this.windowDetachedFromLive();
    }

    /** Someone's read receipt moved. Only the receipts change, so the rows are left alone. */
    private onRoomReceipt = (): void => {
        this.serverReceiptEventId();
        this.updateReadReceipts("receipt");
    };

    /**
     * Our receipt on the server, or the last one seen if the room no longer knows it. As in the old timeline, the
     * receipt the SDK makes up for our own messages does not count: the server may have none for them yet.
     */
    private serverReceiptEventId(): string | null {
        const receipt = this.opts.room.getEventReadUpTo(this.opts.client.getSafeUserId(), true);
        if (receipt) this.knownServerReceiptId = receipt;
        return receipt ?? this.knownServerReceiptId;
    }

    private onRoomStateUpdate = (state: RoomState): void => {
        if (state.roomId !== this.opts.room.roomId) return;
        this.updateReadReceipts("members");
    };

    /**
     * Update the receipts shown beside the current rows. Skipped while a load or rebuild is due,
     * since the rows are about to change and that republish updates the receipts anyway.
     */
    private updateReadReceipts(reason: string): void {
        if (this.isDisposed || !this.showReadReceipts || this.loading || this.rebuildQueued) return;
        this.mergeSnapshot({ readReceiptsByEvent: this.computeReadReceipts() }, reason);
    }

    /** Show or hide other users' read receipts — the room-level `showReadReceipts` setting. */
    /** Whether later loads are read as soon as they are placed; see {@link RoomTimelineViewModelOpts.sendReadReceiptOnLoad}. */
    public setSendReadReceiptOnLoad = (send: boolean): void => {
        this.sendReadReceiptOnLoad = send;
    };

    public setShowReadReceipts(show: boolean): void {
        if (show === this.showReadReceipts) return;
        this.showReadReceipts = show;
        this.mergeSnapshot({ readReceiptsByEvent: this.computeReadReceipts() }, "show-read-receipts");
    }

    private onRoomTimeline = (
        event: MatrixEvent,
        _room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
        removed: boolean,
        data: IRoomTimelineData,
    ): void => {
        // Only events from the room's main timeline. Threads and filtered timelines have their
        // own timeline sets and are not our concern.
        const ourTimelineSet = this.opts.room.getUnfilteredTimelineSet();
        if (data.timeline.getTimelineSet() !== ourTimelineSet) return;

        if (toStartOfTimeline && !removed) {
            this.onHistoryAddedAtStart(data.timeline);
            return;
        }

        // Only genuinely new messages arriving at the end of the timeline. Older messages we
        // fetched ourselves come back through this same event, as do removals, and without this
        // check we would rebuild the whole list every time a reaction or redaction went past.
        if (toStartOfTimeline || removed || data.liveEvent !== true) return;
        if (this.isDisposed) return;

        // The reader has written, here or on another device: what came before is read, as the old timeline moves the
        // marker on to a message they send. Any unread line goes for the rest of the visit, and the room's marker coming
        // from the server only now does not draw one, as when everything is marked read.
        let lineGone = false;
        if (this.isReadersNewMessage(event)) {
            // Decided for the rest of the visit, even when the first load has not finished deciding it yet.
            this.readMarkerFrozen = true;
            this.awaitingServerReadMarker = false;
            lineGone = !!this.frozenMarkerEventId;
            this.frozenMarkerEventId = null;
        }

        debug(`[TimelineVM][onRoomTimeline] live event ${event.getId()} (${event.getType()})`);
        if (this.windowDetachedFromLive()) {
            // The window cannot reach the new live timeline. Count the message for the jump-to-latest button.
            if (event.getSender() !== this.opts.client.getSafeUserId()) this.unreadMessageCount++;
            if (lineGone) this.scheduleRebuild();
            this.mergeSnapshot(
                {
                    atLiveEnd: false,
                    numUnreadMessages: this.unreadMessageCount,
                    hasHighlights: this.opts.room.getUnreadNotificationCount(NotificationCountType.Highlight) > 0,
                },
                "live-event-detached",
            );
            return;
        }
        // Extend the window by one so the new message is inside it, then rebuild.
        void this.timelineWindow
            .paginate(Direction.Forward, 1, false)
            .then(() => {
                if (this.isDisposed) return;
                const items = this.buildItems();

                const atLiveEnd = this.windowReachesLive();
                // Accumulate unread count only for messages from other users.
                if (!this.isAtBottom && event.getSender() !== this.opts.client.getSafeUserId()) {
                    this.unreadMessageCount++;
                }
                this.baseItems = items;
                this.republish("live-event", {
                    atLiveEnd,
                    numUnreadMessages: this.isAtBottom ? 0 : this.unreadMessageCount,
                    hasHighlights: this.opts.room.getUnreadNotificationCount(NotificationCountType.Highlight) > 0,
                    canJumpToReadMarker: this.computeCanJumpToReadMarker(items),
                });
            })
            .catch((err) => {
                logger.warn(`[TimelineVM][onRoomTimeline] forward paginate failed`, err);
            });
    };

    /**
     * A message in our window has decrypted. Rebuild the list so anything we were holding back
     * while it decrypted ({@link shouldIncludeEvent}) now gets a row.
     *
     * This is what guarantees a slow decryption still shows up. Everywhere else that skips an
     * undecrypted message relies on this: the reader never has to scroll, or wait for someone to
     * send something, to see it.
     *
     * Debounced so that a burst of decryptions — which is what a paginate usually triggers —
     * causes one rebuild rather than one per message. Rebuilding per message remounted the rows
     * repeatedly and restarted any media they were downloading.
     */
    private onEventDecrypted = (event: MatrixEvent): void => {
        if (this.isDisposed) return;
        if (!this.timelineWindow.getEvents().includes(event)) return;

        if (this.decryptDebounceTimer !== null) clearTimeout(this.decryptDebounceTimer);
        this.decryptDebounceTimer = setTimeout(() => {
            this.decryptDebounceTimer = null;
            this.flushDecryptRebuild();
        }, RoomTimelineViewModel.DECRYPT_FLUSH_DEBOUNCE_MS);
    };

    /**
     * Rebuild items in response to a settled burst of decryptions, routing the swap
     * through {@link commitItems} (which updates {@link baseItems} and counts newly-shown
     * events; the virtualizer holds scroll position by key, so no index bookkeeping).
     *
     * **Gated against in-flight paginate chains.** If a chain is running, we
     * defer: the chain's terminal {@link buildItems} will pick up everything
     * these decrypts revealed, and a concurrent rebuild here would race the
     * chain's own {@link commitItems} call. We re-arm the debounce timer so we
     * try again after the chain finishes — that way a decrypt that fires deep
     * inside a chain doesn't get lost if no further decrypts arrive.
     */
    private flushDecryptRebuild(): void {
        if (this.isDisposed) return;

        if (this.backwardPaginateChain !== null || this.forwardPaginateChain !== null) {
            // Defer until the chain ends.
            if (this.decryptDebounceTimer === null) {
                this.decryptDebounceTimer = setTimeout(() => {
                    this.decryptDebounceTimer = null;
                    this.flushDecryptRebuild();
                }, RoomTimelineViewModel.DECRYPT_FLUSH_DEBOUNCE_MS);
            }
            return;
        }

        const itemsNew = this.buildItems();
        const prevLength = this.baseItems.length;

        const newCanJumpToReadMarker = this.computeCanJumpToReadMarker(itemsNew);
        const newHasHighlights = this.opts.room.getUnreadNotificationCount(NotificationCountType.Highlight) > 0;

        // Swap in the rebuilt list. Where decryption has revealed a message we were holding back,
        // it slots into place and the view keeps the reader's position by message id.
        const newlyShown = this.commitItems(itemsNew);
        const changed = newlyShown > 0 || itemsNew.length !== prevLength;

        if (!changed) {
            // No rows gained or lost — everything that decrypted turned out to be something we
            // do not show anyway, like a reaction or an edit. Just refresh the derived flags;
            // mergeSnapshot skips the update entirely if none of them actually moved.
            this.mergeSnapshot(
                { canJumpToReadMarker: newCanJumpToReadMarker, hasHighlights: newHasHighlights },
                "decrypt-flush(no-op)",
            );
            return;
        }

        // Items grew (typical: historical encrypted events newly decrypted).
        this.republish(`decrypt-flush(+${newlyShown})`, {
            canJumpToReadMarker: newCanJumpToReadMarker,
            hasHighlights: newHasHighlights,
        });
    }

    /**
     * Wait up to `timeoutMs` for the given encrypted-pending events to decrypt.
     *
     * Resolves as soon as all the given events have either decrypted (success or failure) or the
     * timeout fires, whichever comes first. Waiting here is only an optimisation: anything still
     * undecrypted when we give up is added by {@link onEventDecrypted} once it lands.
     */
    private async waitForDecryption(events: MatrixEvent[], timeoutMs: number): Promise<void> {
        const pending = events.filter(
            (e) => e.isEncrypted() && e.getClearContent() === null && !e.isDecryptionFailure(),
        );
        if (pending.length === 0) return;

        const detachers: Array<() => void> = [];
        const allDecrypted = Promise.all(
            pending.map(
                (e) =>
                    new Promise<void>((resolve) => {
                        if (e.getClearContent() !== null || e.isDecryptionFailure()) {
                            resolve();
                            return;
                        }
                        const handler = (): void => {
                            e.off(MatrixEventEvent.Decrypted, handler);
                            resolve();
                        };
                        e.on(MatrixEventEvent.Decrypted, handler);
                        detachers.push(() => e.off(MatrixEventEvent.Decrypted, handler));
                    }),
            ),
        );

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
            timeoutId = setTimeout(resolve, timeoutMs);
        });

        try {
            await Promise.race([allDecrypted, timeout]);
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            for (const detach of detachers) detach();
        }
    }

    /**
     * A message of ours has just left the composer, changed send state, or been echoed by the
     * server. The rebuild waits for a microtask ({@link scheduleRebuild}) so that, on an echo, it
     * runs after the SDK has moved the message from the pending list into the timeline (where
     * {@link onRoomTimeline} extends the window to hold it); a rebuild in between would find it in
     * neither and drop its row for a frame.
     */
    /** A message was removed, or its removal undone: rebuild if it is in the window, as the old timeline redraws. */
    private onRoomRedaction = (redaction: MatrixEvent): void => {
        if (this.isDisposed) return;
        const redactedId = redaction.event.redacts ?? redaction.getContent().redacts;
        if (typeof redactedId === "string" && !this.timelineWindow.getEvents().some((e) => e.getId() === redactedId)) {
            return;
        }
        this.scheduleRebuild();
    };

    private onLocalEchoUpdated = (event: MatrixEvent, _room: Room, oldEventId?: string): void => {
        if (this.isDisposed) return;
        // Keep the row's continuation decision, so its avatar does not flip when the id changes.
        const newEventId = event.getId();
        if (oldEventId && newEventId && oldEventId !== newEventId) {
            const cached = this.continuationCache.get(oldEventId);
            if (cached !== undefined) {
                this.continuationCache.set(newEventId, cached);
                this.continuationCache.delete(oldEventId);
            }
        }
        this.scheduleRebuild();
    };

    /**
     * Rebuild and republish on the next microtask. Requests made before it runs share that one
     * rebuild, so changes fired together publish once. Waits while a {@link load} is running: its
     * own build, when it finishes, includes whatever is pending by then, and a rebuild in the
     * meantime would publish a half-loaded window without the load's anchor. A load that ends
     * without building, such as one that fails, rebuilds afterwards instead.
     */
    private scheduleRebuild(): void {
        if (this.loading) {
            this.rebuildAfterLoad = true;
            return;
        }
        if (this.rebuildQueued) return;
        this.rebuildQueued = true;
        queueMicrotask(() => {
            this.rebuildQueued = false;
            if (this.isDisposed) return;
            if (this.loading) {
                this.rebuildAfterLoad = true;
                return;
            }
            const rowCountBefore = this.snapshot.current.items.length;
            this.commitItems(this.buildItems());
            this.republish("local-echo", {
                atLiveEnd: this.windowReachesLive(),
                canJumpToReadMarker: this.computeCanJumpToReadMarker(this.baseItems),
            });
            // A message taking its server id keeps its row, so the view reports no new range, yet
            // the bottom row may now take a receipt. Re-read it from the range last reported.
            if (this.snapshot.current.items.length === rowCountBefore) this.updateLastBottomEventAfterEcho();
        });
    }

    /** Re-derives {@link lastBottomEventId} from the last reported range, sending a receipt if it moved. */
    private updateLastBottomEventAfterEcho(): void {
        if (this.lastBottomEventId === null || this.snapshot.current.pendingAnchor !== null) return;
        const items = this.snapshot.current.items;
        const bottom = this.bottomConfirmedEventId(items);
        if (bottom === null || bottom === this.lastBottomEventId) return;
        this.lastBottomEventId = bottom;
        this.lastReceiptTargetId = this.receiptTargetOf(items) ?? this.lastReceiptTargetId;
        this.scheduleReadReceipt();
    }

    private onRoomAccountData = (ev: MatrixEvent): void => {
        if (ev.getType() !== EventType.FullyRead) return;
        const newMarker = (ev.getContent()?.event_id as string | undefined) ?? null;
        const firstFromServer = this.awaitingServerReadMarker;
        this.awaitingServerReadMarker = false;
        if (newMarker === this.readMarkerEventId) return;
        // The server telling us of a move made here, after a later one: the marker is already past it.
        if (
            newMarker !== null &&
            this.sentReadMarkerIds.has(newMarker) &&
            !this.comesAfter(newMarker, this.readMarkerEventId)
        ) {
            return;
        }
        // Track the server-side marker so it is never moved back or written again,
        // but don't touch frozenMarkerEventId — the visible divider position is
        // pinned for the session. If the user wants the marker line to reflect
        // changes another device made mid-session they can leave and re-enter.
        this.readMarkerEventId = newMarker;
        // The line was decided before the room's marker had come from the server. The first one to arrive puts it
        // where it belongs, as in the old timeline, unless the marker has moved on here already.
        if (firstFromServer && this.readMarkerFrozen && this.sentReadMarkerIds.size === 0) {
            this.readMarkerFrozen = false;
            this.freezeReadMarkerForSession();
            this.scheduleRebuild();
        }
    };

    /**
     * Snapshot the current read-marker position into {@link frozenMarkerEventId}.
     * Called by {@link load} after each window is loaded, but decides only once per session: the marker moves on as
     * the reader reads, and a later load, such as jumping to the newest messages, must not move the line with it.
     *
     * The frozen value is what the UI consumes for the entire session, for drawing the line and for going to it:
     *  - The later of the marker and the reader's last message after it in the room's live timeline. A message of the
     *    reader's own means they have read what came before it, as the old timeline moves the marker on to a message
     *    they send, and their own messages are never news to them. Only messages the server has, so not one still
     *    being sent or one that failed.
     *  - `null` when there is no marker, or nobody else wrote after that point (matches the iOS "nothing new since
     *    last visit → no line" behaviour). The line is then not drawn this session even if new events arrive later.
     * It is decided from the live timeline rather than the loaded window, so the line stays put as the window moves.
     * It goes for the rest of the visit once the reader writes; see {@link onRoomTimeline}.
     */
    private freezeReadMarkerForSession(): void {
        if (this.readMarkerFrozen) return;
        this.readMarkerFrozen = true;
        this.frozenMarkerEventId = this.readMarkerEventId ? this.unreadLineAfter(this.readMarkerEventId) : null;
        debug(`[TimelineVM] freezeReadMarkerForSession — frozen=${this.frozenMarkerEventId}`);
    }

    /**
     * Where the unread line goes for the marker `marker`, from the room's live timeline: after the later of the marker
     * and the reader's last new message after it, or nowhere when nobody else wrote after that. A marker older than the
     * live timeline stays where it is unless the reader has written in it since. See {@link freezeReadMarkerForSession}.
     */
    private unreadLineAfter(marker: string): string | null {
        const events = this.opts.room.getLiveTimeline().getEvents();
        const showHiddenEvents = SettingsStore.getValue("showHiddenEventsInTimeline");
        const markerIndex = events.findIndex((event) => event.getId() === marker);
        let after = marker;
        let readerWrote = false;
        let othersAfter = false;
        for (let i = markerIndex + 1; i < events.length; i++) {
            const event = events[i];
            const eventId = event.getId();
            // A message still decrypting is a message all the same: from someone else, it is unread.
            if (!eventId || !(this.isDecrypting(event) || this.shouldIncludeEvent(event, showHiddenEvents))) continue;
            if (this.isReadersNewMessage(event)) {
                after = eventId;
                readerWrote = true;
                othersAfter = false;
            } else if (event.getSender() !== this.opts.client.getSafeUserId()) {
                othersAfter = true;
            }
        }
        // Older than the live timeline: what lies between is not known here, only that the reader has read up to a
        // message they wrote since.
        if (markerIndex < 0 && !readerWrote) return marker;
        return othersAfter ? after : null;
    }

    /** Whether `event` is an encrypted message still waiting to be decrypted, so not yet known to be shown or not. */
    private isDecrypting(event: MatrixEvent): boolean {
        return (
            event.getWireType() === EventType.RoomMessageEncrypted &&
            !event.isDecryptionFailure() &&
            event.getClearContent() === null
        );
    }

    /**
     * Whether `event` is a new message the reader wrote, which the server has: one that means they have read what came
     * before it. Not a reaction, an edit, a reference such as a poll vote, or a redaction, which can touch any older
     * message, nor a change to the room. The relation is on the wire, so it is known before an event is decrypted. Decided
     * by what the event is, whatever is shown: a message shown only with hidden events on is not a new message.
     */
    private isReadersNewMessage(event: MatrixEvent): boolean {
        if (event.getSender() !== this.opts.client.getSafeUserId() || event.status !== null) return false;
        if (event.isState() || event.isRedaction()) return false;
        const relation = event.getWireContent()["m.relates_to"]?.rel_type;
        if (
            relation === RelationType.Replace ||
            relation === RelationType.Annotation ||
            relation === RelationType.Reference
        ) {
            return false;
        }
        return this.isDecrypting(event) || this.shouldIncludeEvent(event, false);
    }

    /** Publish cached rows immediately, then incorporate native history before requesting more. */
    private async loadInitialTimeline(target: LoadTarget): Promise<void> {
        const preparation =
            target.kind === "live"
                ? SlidingSyncManager.instance.initialTimelinePreparation(this.opts.client, this.opts.room.roomId)
                : undefined;
        this.initialTimelinePending = preparation !== undefined;
        const initialLoad = this.load(target);
        if (!preparation) return initialLoad;
        let expanded = false;
        try {
            [, expanded] = await Promise.all([initialLoad, preparation]);
        } catch (error) {
            await initialLoad;
            logger.warn("Native timeline preparation failed; allowing history pagination", error);
        }
        this.initialTimelinePending = false;
        const deferredBackward = this.backwardAfterInitialTimeline;
        this.backwardAfterInitialTimeline = false;
        if (this.isDisposed) return;
        // Expanded native history is prepended to the SDK cache, outside the existing window. Reload the live view
        // to show it unless that would move the reader. A message they went to stays highlighted.
        if (expanded && !this.readingHistory) {
            await this.load({ kind: "live", keepHighlight: true });
        } else if (deferredBackward) {
            this.triggerBackwardPaginate();
        }
    }

    private async load(target: LoadTarget): Promise<void> {
        const generation = ++this.loadGeneration;
        const superseded = (): boolean => this.isDisposed || generation !== this.loadGeneration;
        this.loading = true;
        this.navigationEventId = target.kind === "live" ? null : target.eventId;
        this.navigationToReadMarker = target.kind === "permalink" && !!target.toReadMarker;
        // The window is filled afresh and placed again, and the view says whether its start is shown.
        this.readerPlaced = false;
        this.startInView = false;
        debug(
            `[TimelineVM] load() start — kind=${target.kind}${target.kind !== "live" ? ` eventId=${target.eventId}` : ""}`,
        );
        // A message of ours that the server has not echoed back yet is in no timeline, only in the room's pending list.
        // Asking the server for the messages around it would start a timeline holding it alone, which its echo then
        // never leaves for the live one, so the room would show nothing before it. Like every message being sent, it is
        // shown after the newest messages: load those.
        const sdkLoadTarget =
            target.kind !== "live" && !this.opts.room.getPendingEvent(target.eventId) ? target.eventId : undefined;
        // Each load fills its own window, so one that is overtaken never touches the window being shown.
        const window = new TimelineWindow(this.opts.client, this.opts.room.getUnfilteredTimelineSet(), {
            windowLimit: WINDOW_LIMIT,
        });

        try {
            await window.load(sdkLoadTarget, INITIAL_SIZE);
            if (superseded()) return;
            // Cached live messages should not wait for history. Anchored loads still fill before
            // placement; a live window with no visible events must first look for something to show.
            if (
                target.kind !== "live" ||
                (!this.initialTimelinePending && this.renderableEventCount(window, undefined, Direction.Backward) === 0)
            ) {
                await this.fillInitialWindow(
                    window,
                    target.kind === "permalink" ? sdkLoadTarget : undefined,
                    target.kind === "live" ? 1 : MIN_INITIAL_EVENTS,
                );
            }
            if (superseded()) return;
            if (sdkLoadTarget === undefined) {
                // Sync can start a new live timeline while this window fills, after a gap in sync. A window of the
                // newest messages then loads again from the new one, still going where it was going.
                const liveTimeline = this.opts.room.getUnfilteredTimelineSet().getLiveTimeline();
                if (window.getTimelineIndex(Direction.Forward)?.timeline !== liveTimeline) return this.load(target);
                // Only the window being shown follows new messages, so those that arrived while this one was filled
                // came after its end, such as the echo of a message being sent. A window of the newest messages takes
                // them in.
                this.catchUpWithLiveEnd(window);
            }
            // This is the newest load: its window is shown from now on. Pagination still running on the old window
            // sees the change and stops.
            this.timelineWindow = window;
            const windowEvents = this.timelineWindow.getEvents();
            debug(
                `[TimelineVM] load() window — ${windowEvents.length} events in window, ` +
                    `canPaginate(Backward)=${this.timelineWindow.canPaginate(Direction.Backward)}, ` +
                    `canPaginate(Forward)=${this.timelineWindow.canPaginate(Direction.Forward)}`,
            );
            if (windowEvents.length > 0) {
                debug(
                    `[TimelineVM] load() window first=${windowEvents[0].getId()} (${windowEvents[0].getType()}), ` +
                        `last=${windowEvents[windowEvents.length - 1].getId()} (${windowEvents[windowEvents.length - 1].getType()})`,
                );
            }
            // Snapshot the read-marker for the duration of this session. Must run
            // BEFORE buildItems so it sees the frozen value.
            this.freezeReadMarkerForSession();
            // This build takes in every change asked for while the load ran.
            this.rebuildAfterLoad = false;
            const items = this.buildItems();
            debug(`[TimelineVM] load() done — ${windowEvents.length} events → ${items.length} items after filtering`);

            let pendingAnchor: NavigationAnchor | null = null;

            // Only anchor to a target that is actually in `items` — otherwise the
            // anchor could never settle in view. A permalink/restore target that was
            // filtered (state event, redaction, unrenderable type) falls through to
            // the live-end anchor below.
            if (target.kind === "permalink" && target.toReadMarker && items.some((i) => i.kind === "read-marker")) {
                // Going to the unread line lands on the line, wherever its event is drawn.
                pendingAnchor = { targetKey: "read-marker", align: "third" };
            } else if (target.kind === "permalink") {
                if (items.some((i) => i.key === target.eventId)) {
                    pendingAnchor = { targetKey: target.eventId, align: "center" };
                } else {
                    debug(
                        `[TimelineVM] load() — permalink target ${target.eventId} not in items, falling back to live end`,
                    );
                }
            } else if (target.kind === "restore") {
                if (items.some((i) => i.key === target.eventId)) {
                    pendingAnchor = { targetKey: target.eventId, align: "end" };
                } else {
                    // Saved event was filtered/redacted and can't be displayed.
                    // Clear the stale position so next visit doesn't loop back here.
                    debug(
                        `[TimelineVM] load() — restore target ${target.eventId} not in items, clearing saved position and falling back to live end`,
                    );
                    RoomTimelineViewModel.saveScrollTarget(this.opts.room.roomId, null);
                    // No anchor needed — fall through to live-end logic below.
                }
            }

            if (!pendingAnchor && items.length > 0 && !this.timelineWindow.canPaginate(Direction.Forward)) {
                // Live-end: anchor to the last item so the view lands at the bottom.
                pendingAnchor = { targetKey: items[items.length - 1].key, align: "end" };
                debug(`[TimelineVM] load() — live-end anchor key=${pendingAnchor.targetKey}`);
            }

            const highlighted = this.snapshot.current.highlightedEventId;
            const keepHighlight =
                target.kind === "live" && target.keepHighlight && items.some((item) => item.key === highlighted);
            this.baseItems = items;
            this.backwardSpinnerVisible = false;
            this.forwardSpinnerVisible = false;
            this.republish(`load(${target.kind})-done`, {
                atLiveEnd: this.windowReachesLive(),
                // Keep this for the session, including when the final short history page arrives,
                // so exhausting older history cannot move the messages back to the top.
                alignToBottom: target.kind === "live" && this.hasOlderMessages(),
                pendingAnchor,
                highlightedEventId:
                    target.kind === "permalink" && !target.toReadMarker
                        ? target.eventId
                        : keepHighlight
                          ? highlighted
                          : null,
                canJumpToReadMarker: this.computeCanJumpToReadMarker(items),
            });
            this.receiptOnPlacement = this.sendReadReceiptOnLoad;

            // An empty list cannot report either scroll edge. Search toward live content first,
            // or older history when we are already at the live end, instead of waiting forever.
            if (items.length === 0) {
                if (this.timelineWindow.canPaginate(Direction.Forward)) {
                    this.triggerForwardPaginate();
                } else if (this.hasOlderMessages()) {
                    this.triggerBackwardPaginate();
                }
            }
        } catch (e) {
            if (superseded()) return;
            logger.error(`[TimelineVM] load() error`, e);
            this.backwardSpinnerVisible = false;
            this.forwardSpinnerVisible = false;
            this.republish(`load(${target.kind})-error`);
        } finally {
            if (generation === this.loadGeneration) {
                this.loading = false;
                // A load that ended without building, such as one that failed, leaves those changes to draw now.
                if (this.rebuildAfterLoad) {
                    this.rebuildAfterLoad = false;
                    this.scheduleRebuild();
                }
            }
        }
    }

    /**
     * Fetches enough messages to place an anchored load, or the first visible event for an
     * empty live load. This happens before publishing; live history beyond that first event
     * loads progressively after the view reveals the timeline.
     *
     * Which way we fetch depends on where we are starting:
     *  - **Opening a permalink** (`centreOn` set): the message has to sit in the middle, so it
     *    needs messages on both sides — we aim for about half the target each way. Without the
     *    newer half it would be the last message in the list, and "centre" would put it at the
     *    bottom of the screen instead.
     *  - **Anywhere else**: we start at the newest message, so only older ones are needed.
     *
     * Usually this costs nothing: opening a permalink already fetches the messages around it,
     * and we only go to the server when there is genuinely nothing loaded on that side. Each
     * direction gets a couple of attempts at most, with one server request per attempt. The
     * SDK otherwise retries empty pages internally, multiplying our limit by ten. A room that
     * returns duplicate or hidden events should show what we have before loading more on scroll.
     */
    private async fillInitialWindow(
        window: TimelineWindow,
        centreOn: string | undefined,
        minimumEvents: number,
    ): Promise<void> {
        const MAX_FILL_REQUESTS_PER_DIRECTION = 2;
        const perDirectionTarget = centreOn ? Math.ceil(minimumEvents / 2) : minimumEvents;

        for (const direction of [Direction.Backward, Direction.Forward]) {
            // Unanchored loads only need history above the bottom-anchored view.
            if (!centreOn && direction === Direction.Forward) break;

            let requests = 0;
            while (
                requests < MAX_FILL_REQUESTS_PER_DIRECTION &&
                this.renderableEventCount(window, centreOn, direction) < perDirectionTarget &&
                this.canExtend(window, direction)
            ) {
                requests++;
                const before = window.getEvents().length;
                await window.paginate(direction, PAGINATE_SIZE, true, 1);
                if (this.isDisposed) return;
                debug(
                    `[TimelineVM] fillInitialWindow — paginate(${direction === Direction.Backward ? "backward" : "forward"}) ` +
                        `window: ${before}→${window.getEvents().length}, ` +
                        `renderable(side)=${this.renderableEventCount(window, centreOn, direction)}`,
                );
            }
        }
    }

    /**
     * Take into `window`, loaded at the newest messages, the messages that have arrived since: the live timeline holds
     * them after the window's end. Nothing is fetched.
     */
    private catchUpWithLiveEnd(window: TimelineWindow): void {
        let extended = true;
        while (extended) extended = window.extend(Direction.Forward, PAGINATE_SIZE);
    }

    /**
     * Count renderable events in the window. With `centreOn` set, counts only
     * those strictly on `direction`'s side of that event (so each side of a
     * centred target can be filled independently); without it, counts the whole
     * window. Side-effect-free — does not touch the continuation cache.
     */
    private renderableEventCount(window: TimelineWindow, centreOn: string | undefined, direction: Direction): number {
        const events = window.getEvents();
        const showHiddenEvents = SettingsStore.getValue("showHiddenEventsInTimeline");

        let from = 0;
        let to = events.length;
        if (centreOn) {
            const idx = events.findIndex((e) => e.getId() === centreOn);
            if (idx !== -1) {
                if (direction === Direction.Backward) to = idx;
                else from = idx + 1;
            }
        }

        let count = 0;
        for (let i = from; i < to; i++) {
            if (this.shouldIncludeEvent(events[i], showHiddenEvents)) count++;
        }
        return count;
    }

    // ── TimelineViewActions ──────────────────────────────────────────

    public onStartReached = (): void => {
        debug(`[TimelineVM] onStartReached — items=${this.snapshot.current.items.length}`);
        this.startInView = true;
        this.triggerBackwardPaginate();
    };

    public onStartLeft = (): void => {
        this.startInView = false;
    };

    public onEndReached = (): void => {
        debug("[TimelineVM] onEndReached");
        this.triggerForwardPaginate();
    };

    /**
     * The View reports the anchor placement has settled. We clear `pendingAnchor`,
     * re-enabling `followOutput` and resuming scroll-position / read-receipt tracking.
     * Held until now so the cold-loading list stays pinned to the anchor instead of
     * being snapped to the bottom by the virtualizer's grow-to-bottom trap (see the View's onSettled).
     */
    public onAnchorReached = (targetKey?: string | null): void => {
        const pending = this.snapshot.current.pendingAnchor;
        if (pending === null) return;
        // A newer anchor, such as a message navigated to while the first one was still being placed, stays.
        if (targetKey !== undefined && pending.targetKey !== targetKey) return;
        debug(`[TimelineVM] onAnchorReached — placement settled, clearing pendingAnchor`);
        this.readerPlaced = true;
        this.mergeSnapshot({ pendingAnchor: null }, "anchor-settled");
    };

    public onAtBottomStateChange = (atBottom: boolean): void => {
        this.isAtBottom = atBottom;
        if (atBottom && this.snapshot.current.atLiveEnd) {
            this.unreadMessageCount = 0;
        }
        this.mergeSnapshot(
            {
                isAtBottom: atBottom,
                numUnreadMessages: atBottom && this.snapshot.current.atLiveEnd ? 0 : this.unreadMessageCount,
            },
            "at-bottom",
        );
    };

    /**
     * Called by the View on every visible-range change.
     * Walks backwards from `endIndex` to find the bottommost rendered event,
     * then stores its ID for scroll-position persistence on dispose.
     */
    public onVisibleRangeChanged = (startIndex: number, endIndex: number): void => {
        // Don't record position while an anchor is pending — the range reflects
        // auto-placement, not the user's reading position. The View clears the
        // anchor (via onAnchorReached) once placement settles, after which normal
        // tracking resumes.
        if (this.snapshot.current.pendingAnchor !== null) return;

        const items = this.snapshot.current.items;

        // startIndex/endIndex are 0-based into `items` (the View reports array indices).
        const prevStartArrayIndex = this.visibleStartArrayIndex;
        const prevEndArrayIndex = this.visibleEndArrayIndex;
        this.visibleStartArrayIndex = Math.max(0, startIndex);
        this.visibleEndArrayIndex = Math.max(0, endIndex);

        this.lastBottomEventId = this.bottomConfirmedEventId(items) ?? this.lastBottomEventId;
        this.lastReceiptTargetId = this.receiptTargetOf(items) ?? this.lastReceiptTargetId;
        const readOnPlacement = this.receiptOnPlacement && this.lastBottomEventId !== null;
        if (readOnPlacement) this.receiptOnPlacement = false;

        // Recompute canJumpToReadMarker when the visible range moves.
        if (this.visibleStartArrayIndex !== prevStartArrayIndex || this.visibleEndArrayIndex !== prevEndArrayIndex) {
            const canJumpToReadMarker = this.computeCanJumpToReadMarker(items);
            if (canJumpToReadMarker !== this.snapshot.current.canJumpToReadMarker) {
                this.mergeSnapshot({ canJumpToReadMarker }, "range-changed");
            }
        }

        // As in the old timeline, the marker moves on sooner while it is on screen.
        this.readMarkerTimer?.changeTimeout(this.readMarkerTimeout());

        if (readOnPlacement) {
            // What the reader opened is in front of them: read it now, as the old timeline does on load.
            this.sendReadReceiptNow();
        } else {
            this.scheduleReadReceipt();
        }
    };

    /**
     * The bottommost visible message that has reached the server. A message still being sent has
     * no server id yet, so it can't take a read receipt, and the scroll position can't be restored
     * to it when the room is next opened; the newest confirmed message stands in for it.
     */
    private bottomConfirmedEventId(items: readonly TimelineItem[], skipOwn = false): string | null {
        const me = skipOwn ? this.opts.client.getSafeUserId() : null;
        for (let i = this.visibleEndArrayIndex; i >= this.visibleStartArrayIndex; i--) {
            const item = items[i];
            if (!item) continue;
            const events = this.itemEvents(item);
            for (let j = events.length - 1; j >= 0; j--) {
                const id = events[j].getId();
                if (id && !this.opts.room.hasPendingEvent(id) && events[j].getSender() !== me) return id;
            }
        }
        return null;
    }

    /**
     * The visible message to send a read receipt for. As the old timeline does, it is the bottommost one from someone
     * else: a message of ours says nothing new about what we have read, and receipting it would cost a request each
     * time we send one. With none of theirs on screen, it is the bottommost of ours.
     */
    private receiptTargetOf(items: readonly TimelineItem[]): string | null {
        return this.bottomConfirmedEventId(items, true) ?? this.bottomConfirmedEventId(items);
    }

    /** Debounce sending a read receipt for the last visible event. */
    private scheduleReadReceipt(): void {
        // Otherwise what is on screen is read only when asked; see sendReadReceiptNow.
        if (!this.readStateOnActivity) return;
        // The old timeline reads what is on screen every half second the reader is active, so a message that comes
        // into view while they are active is read even if they stop before the debounce below ends. Only that message:
        // what comes into view after they stopped waits for them.
        if (UserActivity.sharedInstance().userActiveNow()) this.seenWhileActiveEventId = this.lastReceiptTargetId;
        if (this.readReceiptDebounceTimer !== null) clearTimeout(this.readReceiptDebounceTimer);
        this.readReceiptDebounceTimer = setTimeout(() => {
            this.readReceiptDebounceTimer = null;
            const seen = this.seenWhileActiveEventId;
            this.seenWhileActiveEventId = null;
            if (seen === null || UserActivity.sharedInstance().userActiveNow()) {
                this.sendAutoReadReceipt();
                return;
            }
            this.sendAutoReadReceipt(false, seen);
            if (this.lastReceiptTargetId !== seen) this.sendReceiptWhenActive();
        }, READ_RECEIPT_DEBOUNCE_MS);
    }

    /**
     * Sends a read receipt for the last visible event, debounced from `onVisibleRangeChanged`.
     * Only advances the receipt — never rewinds it. Respects the `sendReadReceipts` setting.
     *
     * Read receipts (`m.read`) and the FullyRead marker (`m.fully_read`) serve different
     * purposes. Read receipts are public — they tell *other* users where this user has
     * read up to — and should advance freely as the user scrolls. The FullyRead marker is
     * private and places the "unread divider" line; it moves on separately, while the reader
     * is around (see {@link moveReadMarkerOnWhileActive}), and the divider drawn for this
     * visit stays where it is.
     */
    private sendAutoReadReceipt(requireActivity = true, target: string | null = this.lastReceiptTargetId): void {
        if (!this.maySendReadState()) return;
        // Messages arriving in a window nobody is looking at have not been read. Wait until the user is back,
        // as the old timeline does.
        if (requireActivity && !UserActivity.sharedInstance().userActiveNow()) {
            this.sendReceiptWhenActive();
            return;
        }
        const eventId = target;
        if (!eventId || eventId === this.lastSentReceiptEventId) return;

        const event = this.timelineWindow.getEvents().find((e) => e.getId() === eventId);
        if (!event) return;

        // Don't rewind — only advance past the receipt sent from here and the room's own.
        if (!this.isAfterReceipts(event)) return;

        this.lastSentReceiptEventId = eventId;
        const receiptType = SettingsStore.getValue("sendReadReceipts", this.opts.room.roomId)
            ? ReceiptType.Read
            : ReceiptType.ReadPrivate;

        debug(`[TimelineVM] sendAutoReadReceipt — sending receipt for ${eventId} (${receiptType})`);
        this.opts.client.sendReadReceipt(event, receiptType).catch((err) => {
            this.lastSentReceiptEventId = null; // allow retry
            logger.warn(`[TimelineVM] sendAutoReadReceipt — sendReadReceipt failed`, err);
        });
    }

    /**
     * Whether `event` comes after both the receipt sent from here and our receipt on the server, which another device,
     * or an earlier visit, may have moved on; see {@link comesAfter} and {@link serverReceiptEventId}.
     */
    private isAfterReceipts(event: MatrixEvent): boolean {
        const eventId = event.getId();
        if (!eventId) return false;
        return (
            this.comesAfter(eventId, this.lastSentReceiptEventId) &&
            this.comesAfter(eventId, this.serverReceiptEventId())
        );
    }

    /**
     * How the event `firstId` is placed against `secondId`: below zero before it, zero for the same event, above zero
     * after it, or null when that cannot be told. The window's order is used when it holds both, as after a gap in
     * sync its events may be gone from the room's timelines.
     */
    private orderOf(firstId: string, secondId: string): number | null {
        if (firstId === secondId) return 0;
        const events = this.timelineWindow.getEvents();
        const first = events.findIndex((event) => event.getId() === firstId);
        const second = first < 0 ? -1 : events.findIndex((event) => event.getId() === secondId);
        if (first >= 0 && second >= 0) return first - second;
        return this.opts.room.getUnfilteredTimelineSet().compareEventOrdering(firstId, secondId);
    }

    // ── Requests from the room view ──────────────────────────────────

    /**
     * Abandon any load still running, because the reader has navigated somewhere the rows already shown can serve.
     * Without this, a slower load finishing later would take them back to where it was going.
     */
    private supersedeLoads(): void {
        // The reader is taken elsewhere; the view says again if that shows the start.
        this.startInView = false;
        const wasLoading = this.loading;
        this.loadGeneration++;
        this.loading = false;
        // Updates that arrived during the load were held back for it. Apply them to the rows shown instead.
        if (wasLoading) this.scheduleRebuild();
    }

    /**
     * Show the newest message, loading it first when the window does not hold it. Used when sending a message, by
     * Escape, and by keyboard shortcuts.
     */
    public jumpToLive(): void {
        this.unreadMessageCount = 0;
        if (!this.snapshot.current.atLiveEnd) {
            this.mergeSnapshot({ numUnreadMessages: 0, hasHighlights: false }, "jump-to-live-requested");
            void this.load({ kind: "live" });
            return;
        }
        this.supersedeLoads();
        this.navigationEventId = null;
        const items = this.snapshot.current.items;
        const last = items[items.length - 1];
        this.mergeSnapshot(
            {
                numUnreadMessages: 0,
                hasHighlights: false,
                highlightedEventId: null,
                pendingAnchor: last ? { targetKey: last.key, align: "end" } : null,
            },
            "jump-to-live-requested",
        );
    }

    /**
     * Show a message and highlight it, such as one a permalink, a reply or a pinned message points at in the room
     * already open. A message in the window is scrolled to; any other is loaded with the history around it.
     * @param eventId - The message.
     */
    public showEvent(eventId: string): void {
        if (this.isDisposed) return;
        const loaded = this.snapshot.current.items.some((item) => item.key === eventId);
        if (loaded) {
            this.supersedeLoads();
            this.navigationEventId = eventId;
            this.navigationToReadMarker = false;
            this.mergeSnapshot(
                { highlightedEventId: eventId, pendingAnchor: { targetKey: eventId, align: "center" } },
                "show-event",
            );
        } else {
            void this.load({ kind: "permalink", eventId });
        }
    }

    /** Show the unread line, loading history around it when it is not in the window. */
    public jumpToReadMarker(): void {
        const marker = this.snapshot.current.items.find((item) => item.kind === "read-marker");
        if (marker) {
            this.supersedeLoads();
            this.navigationEventId = this.frozenMarkerEventId;
            this.navigationToReadMarker = true;
            this.mergeSnapshot({ pendingAnchor: { targetKey: marker.key, align: "third" } }, "jump-to-marker");
        } else if (this.frozenMarkerEventId) {
            void this.load({ kind: "permalink", eventId: this.frozenMarkerEventId, toReadMarker: true });
        }
    }

    /**
     * Bring a loaded message into view if it is not visible, such as one someone starts editing. A message outside
     * the window is left alone.
     * @param eventId - The message.
     */
    public scrollToEventIfNeeded(eventId: string): void {
        const items = this.snapshot.current.items;
        const index = items.findIndex((item) => item.key === eventId);
        if (index < 0) return;
        if (index >= this.visibleStartArrayIndex && index <= this.visibleEndArrayIndex) return;
        this.supersedeLoads();
        this.navigationEventId = eventId;
        this.navigationToReadMarker = false;
        this.mergeSnapshot({ pendingAnchor: { targetKey: eventId, align: "center" } }, "scroll-to-event");
    }

    /** Send a read receipt for the last visible message now, such as when the window regains focus. */
    public sendReadReceiptNow(): void {
        if (this.readReceiptDebounceTimer !== null) clearTimeout(this.readReceiptDebounceTimer);
        this.readReceiptDebounceTimer = null;
        this.seenWhileActiveEventId = null;
        this.sendAutoReadReceipt(false);
    }

    /**
     * Move the fully read marker on to the bottommost message the reader sees, now rather than once they have been
     * active for a while, such as when a room view that moves it only on focus is focused. It never moves back.
     */
    public moveReadMarkerOnNow(): void {
        void this.moveReadMarkerOn();
    }

    /** Send the held-back receipt once the user has been active for a moment. */
    private sendReceiptWhenActive(): void {
        if (this.receiptActivityTimer || this.isDisposed) return;
        const timer = new Timer(READ_RECEIPT_DEBOUNCE_MS);
        this.receiptActivityTimer = timer;
        const wait = (): void => {
            UserActivity.sharedInstance().timeWhileActiveNow(timer);
            timer.finished().then(
                () => {
                    if (this.receiptActivityTimer !== timer) return;
                    this.receiptActivityTimer = undefined;
                    this.sendAutoReadReceipt();
                },
                () => {
                    // The user went inactive again before the wait was over: wait for them to come back.
                    if (this.receiptActivityTimer === timer && !this.isDisposed) wait();
                },
            );
        };
        wait();
    }

    /** Whether the reader is at the newest message of the live timeline. */
    public get isAtLiveBottom(): boolean {
        return this.snapshot.current.atLiveEnd && this.isAtBottom;
    }

    /** Whether the unread line is out of view, so offering to jump to it makes sense. */
    public get canJumpToReadMarker(): boolean {
        return this.snapshot.current.canJumpToReadMarker !== false;
    }

    // ── Overlay button actions ───────────────────────────────────────

    public onJumpToReadMarker = (scrollNow: ImmediateScroll): void => {
        const items = this.snapshot.current.items;
        const rmIdx = items.findIndex((item) => item.kind === "read-marker");
        debug(
            `[TimelineVM] onJumpToReadMarker — frozenMarkerEventId=${this.frozenMarkerEventId}, ` +
                `rmIdx=${rmIdx}, items=${items.length}, ` +
                `visibleStartArrayIndex=${this.visibleStartArrayIndex}, ` +
                `canPaginate(Backward)=${this.timelineWindow.canPaginate(Direction.Backward)}, ` +
                `canJumpToReadMarker=${this.snapshot.current.canJumpToReadMarker}`,
        );
        if (rmIdx !== -1) {
            // Marker is in the loaded window — scroll to it imperatively.
            const readMarkerKey = items[rmIdx].key;
            debug(
                `[TimelineVM] onJumpToReadMarker — marker in window at index ${rmIdx}, scrolling now key=${readMarkerKey}`,
            );
            this.supersedeLoads();
            this.navigationEventId = this.frozenMarkerEventId;
            this.navigationToReadMarker = true;
            // A third of the way down, as the old timeline places the line, with the unread messages below it.
            scrollNow({ targetKey: readMarkerKey, align: "third" });
        } else if (this.frozenMarkerEventId && this.hasOlderMessages()) {
            // Frozen marker is not in the current window — reload at it.
            // pendingAnchor gets set inside load() and drives the post-load scroll.
            debug(`[TimelineVM] onJumpToReadMarker — marker not in window, reloading at ${this.frozenMarkerEventId}`);
            void this.load({ kind: "permalink", eventId: this.frozenMarkerEventId, toReadMarker: true });
        } else {
            logger.warn(
                `[TimelineVM] onJumpToReadMarker — no action taken: marker not in window (rmIdx=${rmIdx}) ` +
                    `and frozenMarkerEventId=${this.frozenMarkerEventId}, canPaginate(Backward)=${this.timelineWindow.canPaginate(Direction.Backward)}`,
            );
        }
    };

    public onMarkAllAsRead = (): void => {
        // Use the same logic as the room list "Mark as read" — receipts the last live event
        // in the room and clears the manually-marked-unread state. This ensures the grey dot
        // in the room list is cleared, regardless of the user's scroll position.
        clearRoomNotification(this.opts.room, this.opts.client).catch((err) => {
            logger.warn(`[TimelineVM] onMarkAllAsRead — clearRoomNotification failed`, err);
        });
        // Immediately clear the read marker line locally. This is an explicit
        // user action ("I have read everything"), so we override the per-session
        // freeze and drop the divider line.
        this.frozenMarkerEventId = null;
        // That decides the line for the rest of the visit, even if the room's marker comes from the server only now.
        this.readMarkerFrozen = true;
        this.awaitingServerReadMarker = false;
        const newItems = this.buildItems(); // removes the read-marker item
        this.mergeSnapshot({ items: newItems, canJumpToReadMarker: false }, "mark-all-as-read");
        // And the marker moves on to the newest message, as the old timeline moves it to the receipt, so the line
        // does not come back next visit. The marker is kept until then, so nothing moves it back meanwhile.
        const newest = this.newestConfirmedEventId();
        if (newest) void this.writeReadMarker(newest);
    };

    /** The newest message in the room that has reached the server, or null. */
    private newestConfirmedEventId(): string | null {
        const events = this.opts.room.getLiveTimeline().getEvents();
        for (let i = events.length - 1; i >= 0; i--) {
            const id = events[i].getId();
            if (id && !this.opts.room.hasPendingEvent(id)) return id;
        }
        return null;
    }

    public onJumpToLive = (scrollNow: ImmediateScroll): void => {
        debug(`[TimelineVM] onJumpToLive — atLiveEnd=${this.snapshot.current.atLiveEnd}`);
        this.unreadMessageCount = 0;
        if (!this.snapshot.current.atLiveEnd) {
            // The newest messages are not loaded, so fetch them first. load() sets
            // pendingAnchor, which is what makes the view scroll there once they arrive.
            void this.load({ kind: "live" });
        } else {
            // Already have the latest events — scroll to the last item now.
            this.supersedeLoads();
            this.navigationEventId = null;
            const items = this.snapshot.current.items;
            if (items.length > 0) {
                const targetKey = items[items.length - 1].key;
                debug(`[TimelineVM] onJumpToLive — scrolling now to targetKey=${targetKey}`);
                this.mergeSnapshot(
                    { numUnreadMessages: 0, hasHighlights: false, highlightedEventId: null },
                    "jump-to-live",
                );
                scrollNow({ targetKey, align: "end" });
            } else {
                this.mergeSnapshot(
                    { numUnreadMessages: 0, hasHighlights: false, highlightedEventId: null },
                    "jump-to-live-empty",
                );
            }
        }
    };

    /**
     * Derive whether the "Jump to unread" bar should be shown and in which direction.
     * - `"above"` — marker is above the visible start (or above the loaded window).
     * - `"below"` — marker is below the visible end (within the loaded window).
     * - `false`   — marker is visible, not set, or unreachable.
     *
     * The marker row may have been stripped from `items` by the trailing-strip
     * Driven by `frozenMarkerEventId` (the session-pinned snapshot), not the
     * live server-side `readMarkerEventId`. If the freeze was `null` (no marker
     * or fully read on entry) the button is never offered this session.
     */
    private computeCanJumpToReadMarker(items: TimelineItem[]): "above" | "below" | false {
        if (!this.frozenMarkerEventId) return false;

        const events = this.timelineWindow.getEvents();
        const markerInWindow = events.some((e) => e.getId() === this.frozenMarkerEventId);

        const rmIdx = items.findIndex((item) => item.kind === "read-marker");
        if (rmIdx === -1) {
            if (markerInWindow) {
                // Marker event is in the window but didn't make it into the rendered
                // items — likely a filtered event. Don't show a misleading button.
                return false;
            }
            // Marker is genuinely outside the loaded window. Direction depends on
            // which side has unloaded events. If forward pagination is possible,
            // the marker is newer than our window (e.g. the user has back-paginated
            // past the live edge and the marker fell off via window trimming):
            // "below". Otherwise the marker is older than our window: "above".
            if (this.timelineWindow.canPaginate(Direction.Forward)) return "below";
            if (this.hasOlderMessages()) return "above";
            return false;
        }
        if (rmIdx < this.visibleStartArrayIndex) return "above";
        if (rmIdx > this.visibleEndArrayIndex) return "below";
        return false;
    }

    /**
     * Tear-down: save scroll position and advance the FullyRead marker.
     *
     * - Saves the current scroll position to localStorage so the next visit
     *   resumes here. Clears the saved position only when the user is at the
     *   visual bottom (so the next visit starts fresh at the live end).
     * - Advances the FullyRead marker to the last bottommost event we've seen
     *   during this session, unless that would move it back, so the next time the
     *   user enters the room the "unread divider" reflects what they've actually read.
     *   It also moves on while the reader is around; see {@link moveReadMarkerOnWhileActive}.
     */
    public override dispose(): void {
        if (this.readReceiptDebounceTimer !== null) {
            clearTimeout(this.readReceiptDebounceTimer);
            this.readReceiptDebounceTimer = null;
        }
        const receiptTimer = this.receiptActivityTimer;
        this.receiptActivityTimer = undefined;
        // Settle the timer even if it never started, so UserActivity lets go of it.
        receiptTimer?.start().abort();
        const readMarkerTimer = this.readMarkerTimer;
        this.readMarkerTimer = undefined;
        // The loop may be waiting on a marker write rather than on the timer, so nothing else would see it abort.
        readMarkerTimer?.finished().catch(() => {});
        readMarkerTimer?.start().abort();
        if (this.decryptDebounceTimer !== null) {
            clearTimeout(this.decryptDebounceTimer);
            this.decryptDebounceTimer = null;
        }
        if (!this.lastBottomEventId) {
            debug(`[TimelineVM] dispose() — no visible range recorded, preserving saved position`);
            super.dispose();
            return;
        }

        if (this.isAtBottom) {
            debug(`[TimelineVM] dispose() — clearing saved scroll position (at visual bottom)`);
            RoomTimelineViewModel.saveScrollTarget(this.opts.room.roomId, null);
        } else {
            debug(`[TimelineVM] dispose() — saving scroll position eventId=${this.lastBottomEventId}`);
            RoomTimelineViewModel.saveScrollTarget(this.opts.room.roomId, this.lastBottomEventId);
        }

        // The fully read marker is left alone: it moves on only once the reader has been around for a while, as in
        // the old timeline (see moveReadMarkerOnWhileActive), so a glance at a room keeps its unread line.

        super.dispose();
    }

    // ── Pagination ───────────────────────────────────────────────────

    /**
     * Asks for older messages. Only one fetch runs at a time; a request that arrives
     * while one is running is remembered and run afterwards — see
     * {@link backwardRerunRequested} for why it cannot just be dropped.
     */
    private triggerBackwardPaginate(): void {
        if (this.initialTimelinePending) {
            this.backwardAfterInitialTimeline = true;
            return;
        }
        if (this.backwardPaginateChain) {
            // Remember it rather than dropping it; see backwardRerunRequested.
            this.backwardRerunRequested = true;
            debug(`[TimelineVM] paginate(backward) coalesced — chain in flight, rerun queued`);
            return;
        }

        // Hold off while the first load is still scrolling into place. Rows that have not been
        // measured yet have no height, so the view can briefly think both ends are on screen and
        // ask for more history it does not need — which also disturbs the placement. Once the
        // anchor settles the view clears pendingAnchor, and the reader's own scrolling asks again.
        if (this.snapshot.current.pendingAnchor !== null) {
            debug(`[TimelineVM] paginate(backward) skipped — anchor placement pending`);
            return;
        }

        if (!this.hasOlderMessages()) {
            debug(`[TimelineVM] paginate(backward) skipped — no older messages`);
            return;
        }

        this.backwardPaginateChain = this.runPaginateChain(Direction.Backward).finally(() => {
            this.backwardPaginateChain = null;
            if (this.backwardRerunRequested && !this.isDisposed) {
                this.backwardRerunRequested = false;
                debug(`[TimelineVM] paginate(backward) — running queued rerun`);
                this.triggerBackwardPaginate();
            }
        });
    }

    /**
     * Entry point for forward pagination. Coalesces concurrent `onEndReached`
     * calls behind a single in-flight chain.
     */
    private triggerForwardPaginate(): void {
        if (this.forwardPaginateChain) {
            // Remember it rather than dropping it; see backwardRerunRequested.
            this.forwardRerunRequested = true;
            debug(`[TimelineVM] paginate(forward) coalesced — chain in flight, rerun queued`);
            return;
        }

        // Wait until the first messages have been positioned; see triggerBackwardPaginate.
        if (this.snapshot.current.pendingAnchor !== null) {
            debug(`[TimelineVM] paginate(forward) skipped — anchor placement pending`);
            return;
        }

        debug(
            `[TimelineVM] paginate(forward) check — canPaginate=${this.timelineWindow.canPaginate(Direction.Forward)}, ` +
                `atLiveEnd=${this.snapshot.current.atLiveEnd}, items=${this.snapshot.current.items.length}`,
        );

        if (!this.timelineWindow.canPaginate(Direction.Forward)) {
            debug(`[TimelineVM] paginate(forward) skipped — canPaginate=false`);
            if (!this.snapshot.current.atLiveEnd && this.windowReachesLive()) {
                debug(`[TimelineVM] paginate(forward) — setting atLiveEnd=true`);
                this.mergeSnapshot({ atLiveEnd: true }, "paginate(forward)-at-live-end");
            }
            return;
        }

        this.forwardPaginateChain = this.runPaginateChain(Direction.Forward).finally(() => {
            this.forwardPaginateChain = null;
            if (this.forwardRerunRequested && !this.isDisposed) {
                this.forwardRerunRequested = false;
                debug(`[TimelineVM] paginate(forward) — running queued rerun`);
                this.triggerForwardPaginate();
            }
        });
    }

    /**
     * Keys for the two loading spinners. {@link republish} adds these to the list on the way
     * out to the view and they are never kept in {@link baseItems}, so each can appear at most
     * once per end.
     *
     * They are ordinary list rows rather than something fixed above or below the list. That way
     * the view measures their height like any other row and can absorb one appearing or
     * disappearing without the messages jumping.
     */
    private static readonly BACKWARD_LOADING_KEY = "backward-loading";
    private static readonly FORWARD_LOADING_KEY = "forward-loading";

    /**
     * Publish {@link baseItems} to the View, layering spinners on top:
     * `[ (backward?), ...baseItems, (forward?) ]`.
     */
    private republish(reason: string, extra: Partial<RoomTimelineViewSnapshot> = {}): void {
        const items: TimelineItem[] = [];
        if (this.backwardSpinnerVisible) {
            items.push({ kind: "loading", key: RoomTimelineViewModel.BACKWARD_LOADING_KEY });
        }
        items.push(...this.baseItems);
        if (this.forwardSpinnerVisible) {
            items.push({ kind: "loading", key: RoomTimelineViewModel.FORWARD_LOADING_KEY });
        }
        const events = this.loadedEvents();
        const isShown = this.shownEventTest();
        this.mergeSnapshot(
            {
                items,
                readReceiptsByEvent: this.computeReadReceipts(events, isShown),
                lastSuccessfulEventId: this.computeLastSuccessfulEventId(events, isShown),
                ...extra,
            },
            reason,
        );
    }

    /**
     * Swap {@link baseItems} for a freshly-built array and report how many events newly
     * entered. Scroll position is preserved by the virtualizer's own key-based anchoring,
     * so no index bookkeeping is needed here.
     *
     * @returns the number of events that newly entered the list — the only reliable
     *   progress signal for the paginate loop once trimming has made net array length
     *   meaningless.
     */
    private commitItems(rebuilt: TimelineItem[]): number {
        const oldEventKeys = new Set<string>();
        for (const item of this.baseItems) {
            for (const event of this.itemEvents(item)) oldEventKeys.add(event.getId()!);
        }

        let newlyShown = 0;
        for (const item of rebuilt) {
            for (const event of this.itemEvents(item)) {
                if (!oldEventKeys.has(event.getId()!)) newlyShown++;
            }
        }

        this.baseItems = rebuilt;
        return newlyShown;
    }

    /**
     * Stage the window's far-end trim as its own update *before* extending the
     * near end, so the virtualizer never sees an add-at-one-end + trim-at-the-other in a
     * single change.
     *
     * The virtualizer only holds scroll position when an update is "pure": items added
     * or removed at the top (it compensates scrollTop) or added at the bottom (no
     * compensation needed). An update that extends one end and trims the other is neither,
     * and rather than guess how far to adjust the virtualizer stops compensating altogether —
     * so the viewport shifts by the height of whatever was trimmed. At the window cap the
     * SDK's `paginate()` does exactly that combination, which is the on-append scroll jump.
     *
     * So when a paginate is about to overflow {@link WINDOW_LIMIT}, we first
     * `unpaginate()` the far end ourselves and publish that as a standalone,
     * compensated trim, then yield a frame. The subsequent `paginate()` now has
     * room and lands as a pure extend. Both directions are covered by the shared
     * chain: forward extends the end so we trim the start; backward is the mirror.
     *
     * Below the cap `toTrim <= 0` and this is a no-op — the normal pure-append /
     * pure-prepend path is untouched.
     */
    private async makeRoomBeforeExtending(direction: Direction, dirLabel: string): Promise<void> {
        const windowSize = this.timelineWindow.getEvents().length;
        const toTrim = windowSize + PAGINATE_SIZE - WINDOW_LIMIT;
        if (toTrim <= 0) return;

        // Forward extends the end, so the SDK would trim the start (startOfTimeline=true);
        // backward extends the start, so it would trim the end. Mirror that here.
        const trimStartOfTimeline = direction === Direction.Forward;
        try {
            this.timelineWindow.unpaginate(toTrim, trimStartOfTimeline);
        } catch (e) {
            // Defensive: if the window can't give back this many events we simply
            // skip the pre-trim and let paginate() do its combined extend+trim.
            logger.warn(`[TimelineVM] makeRoomBeforeExtending — unpaginate(${toTrim}) failed, falling back`, e);
            return;
        }

        const newlyShown = this.commitItems(this.buildItems());
        debug(
            `[TimelineVM] paginate(${dirLabel}) pre-trim — unpaginated=${toTrim} ` +
                `(window→${this.timelineWindow.getEvents().length}), newlyShown=${newlyShown}`,
        );
        this.republish(`paginate(${dirLabel})-trim`, {
            atLiveEnd: this.windowReachesLive(),
            canJumpToReadMarker: this.computeCanJumpToReadMarker(this.baseItems),
        });

        // Yield a frame so React commits the trim and the virtualizer applies its scroll
        // compensation before we publish the extend in the next update.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    /**
     * Fetches more history in one direction. Used for both ends; `direction` says which.
     *
     * It loops rather than fetching once, because a batch from the server can turn out to
     * contain nothing we display — a run of membership changes or other hidden events. Rather
     * than finish having added no rows, we keep asking until something showable arrives, we run
     * out of history, or we hit `MAX_EMPTY_RETRIES`. The spinner stays up for the whole loop, so
     * however many batches that takes it reads as one wait rather than a flicker per batch.
     *
     * Rows are published after each batch. Encrypted messages appear straight away, before they
     * are decrypted; decryption later changes what a row contains but never adds or removes
     * rows, so it cannot disturb the list from here.
     *
     * Both directions hand the rebuilt list over via {@link commitItems}, and the view keeps the
     * reader's place by message id, so nothing here needs to care which end the SDK dropped
     * messages from. The one real difference is `atLiveEnd`: once the window is full, paginating
     * backwards trims the newest messages, which flips that flag from true to false as a side
     * effect. It gates the view's stick-to-bottom, so leaving a stale `true` in place would drag
     * the reader to the bottom if a message arrived mid-chain — hence we republish it after every
     * backward batch. Forward pagination only ever trims the oldest, so it cannot touch the flag
     * and one check once the loop finishes is enough.
     */
    private async runPaginateChain(direction: Direction): Promise<void> {
        // A backstop: the loop already stops when canPaginate() or hasMore say
        // there is no more history. This caps how long it can keep fetching nothing displayable
        // off the back of a single scroll — after this many empty batches we stop and wait for the
        // reader to scroll again rather than walk the whole room unprompted.
        const MAX_EMPTY_RETRIES = 10;
        const isBackward = direction === Direction.Backward;
        const dirLabel = isBackward ? "backward" : "forward";

        if (isBackward) {
            this.backwardSpinnerVisible = true;
            this.republish("paginate(backward)-start");
        } else {
            this.forwardSpinnerVisible = true;
            this.republish("paginate(forward)-start");
        }

        // The chain belongs to the window it started on. A load that replaces the window ends it.
        const window = this.timelineWindow;
        const replaced = (): boolean => this.isDisposed || this.timelineWindow !== window;
        try {
            let emptyBatches = 0;

            while (emptyBatches <= MAX_EMPTY_RETRIES) {
                if (!this.canExtend(this.timelineWindow, direction)) {
                    debug(`[TimelineVM] paginate(${dirLabel}) chain end — canPaginate=false`);
                    break;
                }

                // If this paginate would overflow the window cap, stage the
                // far-end trim as its own compensated update first so the extend
                // below lands as a pure add (no on-append scroll jump). No-op
                // below the cap.
                await this.makeRoomBeforeExtending(direction, dirLabel);
                if (replaced()) return;

                const eventsBefore = new Set(window.getEvents());
                const hasMore = await window.paginate(direction, PAGINATE_SIZE, true, 1);
                if (replaced()) return;
                const eventsAfter = window.getEvents();

                // Give newly-fetched encrypted messages a moment to decrypt, so buildItems can
                // see what they really are and decide once whether to show them. Any that take
                // longer are added by onEventDecrypted when they finish.
                const newEvents = eventsAfter.filter((e) => !eventsBefore.has(e));
                if (newEvents.length > 0) {
                    await this.waitForDecryption(newEvents, PAGINATE_DECRYPT_WAIT_MS);
                    if (replaced()) return;
                }

                const rebuilt = this.buildItems();

                // `newlyShown` counts the events that newly entered the list. Once the window is
                // trimming at its limit the array length alone says nothing, so this is the only
                // reliable signal that the batch made progress.
                const newlyShown = this.commitItems(rebuilt);
                debug(`[TimelineVM] paginate(${dirLabel}) batch — newlyShown=${newlyShown}, hasMore=${hasMore}`);

                if (isBackward) {
                    this.republish("paginate(backward)-batch", {
                        // Backward pagination can trim the newest messages away once the window is
                        // full, so re-check whether we are still at the live end.
                        atLiveEnd: this.windowReachesLive(),
                        canJumpToReadMarker: this.computeCanJumpToReadMarker(rebuilt),
                    });
                } else {
                    this.republish("paginate(forward)-batch", {
                        canJumpToReadMarker: this.computeCanJumpToReadMarker(rebuilt),
                    });
                }

                // With one SDK request per batch, false can mean an empty or duplicate page,
                // even when its continuation token still points to more history.
                if (newlyShown > 0 || !this.canExtend(this.timelineWindow, direction)) break;
                emptyBatches++;
            }

            if (isBackward) {
                this.backwardSpinnerVisible = false;
                this.republish("paginate(backward)-end", {
                    atLiveEnd: this.windowReachesLive(),
                });
            } else {
                this.forwardSpinnerVisible = false;
                this.republish("paginate(forward)-end", {
                    atLiveEnd: this.windowReachesLive(),
                });
            }
        } catch (e) {
            logger.error(`[TimelineVM] paginate(${dirLabel}) error`, e);
            if (isBackward) {
                this.backwardSpinnerVisible = false;
                this.republish("paginate(backward)-error");
            } else {
                this.forwardSpinnerVisible = false;
                this.republish("paginate(forward)-error");
            }
        }
    }

    // ── Snapshot construction ────────────────────────────────────────

    /**
     * Messages of ours the server has not echoed yet. The client holds them outside the timeline
     * (`PendingEventOrdering.Detached`, set in MatrixClientPeg), so without this they would only
     * show after the next sync, and never as sending or failed. As in the old timeline, they go
     * last, and only while the newest messages are loaded so they never land in old history.
     * Thread replies being sent are left out; pending edits and reactions are dropped later by
     * {@link shouldIncludeEvent}, like any other event.
     */
    private pendingEventsToShow(): MatrixEvent[] {
        if (this.timelineWindow.canPaginate(Direction.Forward)) return [];
        const pendingEvents = this.opts.room.getPendingEvents();
        return pendingEvents.filter((event) => this.opts.room.eventShouldLiveIn(event, pendingEvents).shouldLiveInRoom);
    }

    /** The loaded events followed by our pending ones, oldest first: what {@link buildItems} draws rows from. */
    private loadedEvents(): MatrixEvent[] {
        return [...this.timelineWindow.getEvents(), ...this.pendingEventsToShow()];
    }

    private static readonly CONTINUATION_MAX_INTERVAL = 5 * 60 * 1000;
    private static readonly CONTINUED_TYPES = new Set(["m.room.message", "m.sticker"]);

    /**
     * Which read receipts to draw beside which message, worked out by the same code as the old
     * timeline's, over the loaded and pending events, with a row for each event in {@link baseItems}.
     */
    private computeReadReceipts(
        events = this.loadedEvents(),
        isShown = this.shownEventTest(),
    ): ReadonlyMap<string, IReadReceiptProps[]> {
        const previous = this.snapshot.current.readReceiptsByEvent;
        if (!this.showReadReceipts) {
            this.receiptsByUserId = new Map();
            return previous.size === 0 ? previous : new Map();
        }
        const { room, client } = this.opts;
        const myUserId = client.getSafeUserId();
        const { receiptsByEvent, receiptsByUserId } = getReadReceiptsByShownEvent(
            events,
            isShown,
            (event) => getReadReceiptsForEvent(event, room, room, client, myUserId),
            this.receiptsByUserId,
        );
        this.receiptsByUserId = receiptsByUserId;
        // Keep what is already published where nothing moved, so those rows are not redrawn.
        return reuseUnchangedReadReceipts(previous, receiptsByEvent);
    }

    /** The message showing a "Sent" tick in place of read receipts, if any; see {@link findLastSuccessfulWeSent}. */
    private computeLastSuccessfulEventId(
        events: readonly MatrixEvent[],
        isShown: (event: MatrixEvent) => boolean,
    ): string | null {
        // Pending messages count: one the server has accepted takes the tick before its echo arrives.
        const index = findLastSuccessfulWeSent(events, isShown, this.opts.client.getSafeUserId());
        return index >= 0 ? (events[index].getId() ?? null) : null;
    }

    /** Whether an event has a row of its own in {@link baseItems}. */
    private shownEventTest(): (event: MatrixEvent) => boolean {
        const shownEventIds = new Set<string>();
        for (const item of this.baseItems) {
            for (const event of this.itemEvents(item)) shownEventIds.add(event.getId()!);
        }
        return (event) => shownEventIds.has(event.getId()!);
    }

    private buildItems(): TimelineItem[] {
        const events: MatrixEvent[] = this.loadedEvents();
        const items: TimelineItem[] = [];
        let lastDate: string | null = null;
        let prevEvent: MatrixEvent | null = null;
        let filteredCount = 0;
        // Tracks which date keys have already had a separator emitted. Rooms
        // with out-of-order server-clock events can produce a timeline where the
        // same calendar date appears in multiple non-contiguous runs. Without
        // this guard, `buildItems` would emit a second separator with the same
        // key, causing a React key collision and the virtualizer rendering the same
        // separator slot multiple times in the DOM.
        const emittedDateKeys = new Set<string>();

        const showHiddenEvents = SettingsStore.getValue("showHiddenEventsInTimeline");
        // Suppress the leading date separator when more history is available
        // behind the current window — the backward pagination spinner
        // visually fills that role, matching the legacy `MessagePanel`
        // behaviour (see `wantsSeparator` in MessagePanel.tsx). Once we've
        // hit the start of the timeline we let the leading separator render
        // so the user sees an explicit "this is the start" marker.
        const suppressLeadingSeparator = this.hasOlderMessages();

        for (const event of events) {
            const eventId = event.getId();
            if (!eventId) continue;

            // Messages still being decrypted are left out, so the view never measures a small
            // placeholder it has to swap for a full message a moment later — the repeated
            // re-measuring was the original cause of the timeline going blank. They are added at
            // their real size once decryption finishes (see onEventDecrypted).
            if (!this.shouldIncludeEvent(event, showHiddenEvents)) {
                filteredCount++;
                continue;
            }

            // Insert date separator when the day changes (or for the very
            // first event when we're at the start of the timeline). Only
            // reached for events that pass the inclusion filter, so
            // separators are never orphaned.
            const eventDate = new Date(event.getTs());
            const dateKey = eventDate.toDateString();
            const isLeadingEvent = lastDate === null;
            if (
                dateKey !== lastDate &&
                !emittedDateKeys.has(dateKey) &&
                !(isLeadingEvent && suppressLeadingSeparator)
            ) {
                items.push({
                    key: `date-${dateKey}`,
                    kind: "date-separator",
                    ts: event.getTs(),
                });
                emittedDateKeys.add(dateKey);
                prevEvent = null; // date separator breaks continuation
            }
            // Track the most recently seen day even when we suppressed the
            // separator so we still emit one when the day changes mid-list.
            lastDate = dateKey;

            // A message of ours keeps its tile as its id changes to the server's, as the old timeline keys its tiles.
            const txnId = event.getTxnId();
            items.push({
                key: eventId,
                ...(txnId ? { tileKey: txnId } : {}),
                kind: "event",
                event,
                continuation: this.getCachedContinuation(eventId, prevEvent, event),
                lastInSection: false, // computed in the post-pass below, once the next event is known
                sendState: sendStateOf(event),
            });

            // Insert the read-marker item directly after the event it belongs to.
            // Uses the per-session frozen marker so the divider position never
            // changes during the session (see {@link freezeReadMarkerForSession}).
            // Works correctly for wire-encrypted anchors too, because the slot
            // exists immediately.
            if (this.frozenMarkerEventId && eventId === this.frozenMarkerEventId) {
                items.push({ key: "read-marker", kind: "read-marker" });
            }

            prevEvent = event;
        }

        // lastInSection: an event closes its continuation group when the next
        // event does not continue from it (or it is the last event). This mirrors
        // the grouping MessagePanel derives for the legacy timeline; bubble layout
        // rounds a group's closing corner off it. Mutating the filtered references
        // mutates the originals in `items` (same objects). Recomputed each build —
        // it only drives border-radius, so a flip has no height/scroll impact.
        const eventItems = items.filter((it): it is Extract<TimelineItem, { kind: "event" }> => it.kind === "event");
        for (let i = 0; i < eventItems.length; i++) {
            eventItems[i].lastInSection = i === eventItems.length - 1 || !eventItems[i + 1].continuation;
        }

        debug(
            `[TimelineVM][buildItems] emitted ${items.length} items from ${events.length} window+pending events, ` +
                `filtered=${filteredCount}`,
        );

        return this.groupGalleries(
            this.groupSummarisedItems(this.groupRoomCreation(items, events, showHiddenEvents), showHiddenEvents),
        );
    }

    /**
     * The events that set the room up, as the old timeline groups them: from `m.room.create`, the creator's own state
     * events and their own join, until another day, another kind of event, someone else, a membership other than the
     * creator's join, or a live location share. Events without a row of their own do not end the run.
     * @returns The ids of the grouped events, and of the encryption events, which keep a row of their own, or nothing
     *   when the room's start is not loaded or nothing would be grouped.
     */
    private creationRun(
        events: MatrixEvent[],
        showHiddenEvents: boolean,
    ): { createId: string; grouped: Set<string>; ownRows: Set<string> } | undefined {
        const start = events.findIndex((event) => event.getType() === EventType.RoomCreate);
        if (start < 0) return undefined;
        const create = events[start];
        const creator = create.getSender();
        const day = new Date(create.getTs()).toDateString();
        const grouped = new Set<string>();
        const ownRows = new Set<string>();
        for (const event of events.slice(start + 1)) {
            const id = event.getId();
            if (!id || !this.shouldIncludeEvent(event, showHiddenEvents)) continue;
            if (new Date(event.getTs()).toDateString() !== day) break;
            const type = event.getType();
            if (
                type === EventType.RoomMember &&
                (event.getStateKey() !== creator || event.getContent().membership !== KnownMembership.Join)
            ) {
                break;
            }
            if (M_BEACON_INFO.matches(type)) break;
            if (!event.isState() || event.getSender() !== creator) break;
            if (type === EventType.RoomEncryption) ownRows.add(id);
            else grouped.add(id);
        }
        return grouped.size > 0 ? { createId: create.getId()!, grouped, ownRows } : undefined;
    }

    /**
     * Collapse the events that set the room up into one summary row, as the old timeline does, with the room's
     * introduction above it. Encryption being turned on keeps its own row, before the summary, and a read marker
     * among the grouped events follows the summary. Once shown, the summary keeps the events it was shown with, and
     * takes in the ones that arrive later, such as when sync brings a new room in more than one go, but none the
     * reader has seen in a row of its own while scrolled away from the newest messages.
     *
     * The events keep rows of their own for the rest of the visit when the reader is taken to one of them, such as by
     * a link, so it has a row to land on, and when the reader, scrolled away from the newest messages, has already
     * seen them in rows of their own, such as after paging back to the start of the room, as collapsing rows they
     * are reading would lose their place. Going to the unread line lands on the line, so it leaves the summary.
     */
    private groupRoomCreation(items: TimelineItem[], events: MatrixEvent[], showHiddenEvents: boolean): TimelineItem[] {
        const run = this.creationRun(events, showHiddenEvents);
        if (!run) {
            // The start of the room is not loaded: whatever is drawn later is decided afresh.
            this.creationGroup = undefined;
            return items;
        }
        if (this.creationDeclined === run.createId) return items;
        const formed = this.creationGroup?.createId === run.createId ? this.creationGroup.ids : undefined;
        const pendingKey = this.snapshot.current.pendingAnchor?.targetKey;
        const targets = [
            this.navigationToReadMarker ? null : this.navigationEventId,
            this.snapshot.current.highlightedEventId,
            pendingKey === "read-marker" ? null : pendingKey,
        ];
        if (targets.some((id) => id && (formed?.has(id) || run.grouped.has(id)))) {
            return this.declineCreationGroup(run.createId, items);
        }
        // Rows the reader has seen are not collapsed while they are scrolled away from the newest messages. A reader
        // at the newest messages stays there whatever changes above, such as in a new room whose start arrives just
        // after its newest event was drawn.
        const seen = new Set<string>();
        if (this.readerPlaced && !this.isAtBottom) {
            for (const item of this.snapshot.current.items) {
                for (const event of this.itemEvents(item)) seen.add(event.getId()!);
            }
        }
        if (!formed && [...run.grouped].some((id) => seen.has(id)))
            return this.declineCreationGroup(run.createId, items);
        // The run's events in order, those that arrived since the summary was shown included, such as when sync
        // brings a new room in more than one go, up to the first the reader has seen in a row of its own.
        const ids = new Set(formed);
        for (const id of run.grouped) {
            if (ids.has(id)) continue;
            if (seen.has(id)) break;
            ids.add(id);
        }
        this.creationGroup = { createId: run.createId, ids };

        const result: TimelineItem[] = [];
        const grouped: MatrixEvent[] = [];
        const ownRows: TimelineItem[] = [];
        let marker: TimelineItem | undefined;
        let groupAt = -1;
        let groupedSeen = 0;
        const groupedLoaded = items.filter((item) => item.kind === "event" && ids.has(item.key)).length;
        for (const item of items) {
            if (item.kind === "event" && ids.has(item.key)) {
                if (groupAt < 0) groupAt = result.length;
                grouped.push(item.event as MatrixEvent);
                groupedSeen++;
            } else if (groupAt >= 0 && item.kind === "event" && run.ownRows.has(item.key)) {
                // Before the summary, wherever it falls in the run, as in the old timeline.
                ownRows.push(item);
            } else if (groupAt >= 0 && groupedSeen < groupedLoaded && item.kind === "read-marker") {
                marker = item;
            } else {
                result.push(item);
            }
        }
        if (groupAt < 0) return items;
        result.splice(
            groupAt,
            0,
            ...ownRows,
            { kind: "event-group", key: `creation-${run.createId}`, events: grouped, variant: "creation" },
            ...(marker ? [marker] : []),
        );
        return result;
    }

    /** Leave the start of a room in rows of their own for the rest of this visit. */
    private declineCreationGroup(createId: string, items: TimelineItem[]): TimelineItem[] {
        this.creationGroup = undefined;
        this.creationDeclined = createId;
        return items;
    }

    /** The real events represented by a row, also used for receipts and saved positions. */
    private itemEvents(item: TimelineItem): readonly MatrixEvent[] {
        if (item.kind === "event") return [item.event as MatrixEvent];
        if (item.kind === "event-group") return item.events as MatrixEvent[];
        return [];
    }

    /**
     * Sum up runs of events as the old timeline's `MainGrouper` does: each run of events {@link isSummarised} on one
     * day becomes one summary row, however short. A summary of fewer than three events shows the events themselves.
     * An event the reader is being taken to keeps a row of its own, so there is a row to land on. A read marker on an
     * event in a run follows the whole summary, as in the old timeline. A summary that opens the room as far back as
     * the reader can see is marked `startsHistory`, as the old timeline then says why there is nothing earlier.
     */
    private groupSummarisedItems(items: TimelineItem[], showHiddenEvents: boolean): TimelineItem[] {
        const result: TimelineItem[] = [];
        const usedKeys = new Set<string>();
        let run: Extract<TimelineItem, { kind: "event" }>[] = [];
        // The read marker on an event in the current run, put after its summary.
        let marker: TimelineItem | undefined;
        const flush = (): void => {
            if (run.length === 0) return;
            const events = run.map((item) => item.event as MatrixEvent);
            // Remember every event so trimming away the original first event does not
            // remount the summary. A split may reuse its old key only once in this list.
            const keyedEvent = events.find((event) => {
                const key = this.summaryGroupKeys.get(event);
                return key !== undefined && !usedKeys.has(key);
            });
            const key = keyedEvent
                ? this.summaryGroupKeys.get(keyedEvent)!
                : `summary-${run[0].key}-${this.summaryGroupSequence++}`;
            usedKeys.add(key);
            for (const event of events) this.summaryGroupKeys.set(event, key);
            // Each event's own row comes along, so it is drawn inside the summary as it would be on its own.
            result.push({ kind: "event-group", key, events, rows: run });
            if (marker) result.push(marker);
            run = [];
            marker = undefined;
        };
        // Going to the unread line lands on the line, wherever its event is drawn.
        const protectedIds = new Set([
            this.navigationToReadMarker ? null : this.navigationEventId,
            this.snapshot.current.highlightedEventId,
            this.snapshot.current.pendingAnchor?.targetKey,
        ]);
        for (const item of items) {
            if (item.kind === "read-marker" && run.length > 0) {
                marker = item;
            } else if (
                item.kind === "event" &&
                !protectedIds.has(item.key) &&
                this.isSummarised(item.event as MatrixEvent, showHiddenEvents)
            ) {
                if (
                    run.length > 0 &&
                    new Date((run[0].event as MatrixEvent).getTs()).toDateString() !==
                        new Date((item.event as MatrixEvent).getTs()).toDateString()
                ) {
                    flush();
                }
                run.push(item);
            } else {
                flush();
                result.push(item);
            }
        }
        flush();
        if (!this.hasOlderMessages()) {
            const first = result.find((item) => item.kind === "event" || item.kind === "event-group");
            if (first?.kind === "event-group" && first.variant === undefined) first.startsHistory = true;
        }
        return result;
    }

    /**
     * Lay out pictures one person sends together as the old timeline's `GalleryGrouper` does, in the desktop shell:
     * the first stays an ordinary row, and the ones that follow it from the same person, each within
     * {@link GALLERY_WINDOW_MS} of the one before, become one gallery row under it. A read marker among them moves
     * after the gallery. A picture the reader is being taken to keeps a row of its own, so there is a row to land on.
     */
    private groupGalleries(items: TimelineItem[]): TimelineItem[] {
        if (!SettingsStore.getValue("feature_desktop_shell")) return items;
        const pendingKey = this.snapshot.current.pendingAnchor?.targetKey;
        const targets = new Set([
            this.navigationToReadMarker ? null : this.navigationEventId,
            this.snapshot.current.highlightedEventId,
            pendingKey === "read-marker" ? null : pendingKey,
        ]);
        const result: TimelineItem[] = [];
        const usedKeys = new Set<string>();
        let index = 0;
        while (index < items.length) {
            const first = items[index++];
            result.push(first);
            if (first.kind !== "event" || !isGalleryMedia(first.event as MatrixEvent, true)) continue;

            let previous = first.event as MatrixEvent;
            const rest: Extract<TimelineItem, { kind: "event" }>[] = [];
            let marker: TimelineItem | undefined;
            while (index < items.length) {
                const item = items[index];
                if (item.kind === "read-marker" && !marker) {
                    marker = item;
                    index++;
                    continue;
                }
                if (item.kind !== "event" || targets.has(item.key)) break;
                const event = item.event as MatrixEvent;
                if (
                    !isGalleryMedia(event, false) ||
                    event.getSender() !== previous.getSender() ||
                    event.getTs() - previous.getTs() > GALLERY_WINDOW_MS ||
                    // As the old timeline's `GalleryGrouper` does, never across a change of day or of late messages,
                    // whether a separator is drawn there or not, such as when a message's time is out of order.
                    wantsDateSeparator(previous.getDate() ?? undefined, event.getDate() ?? undefined) ||
                    getLateEventInfo(event)?.group_id !== getLateEventInfo(previous)?.group_id
                ) {
                    break;
                }
                rest.push(item);
                previous = event;
                index++;
            }
            if (rest.length > 0) {
                const events = rest.map((item) => item.event as MatrixEvent);
                // A gallery keeps its key while any of its pictures stay in it, such as when an earlier picture loads
                // and joins it, or the first ones are trimmed away, so the view keeps its measured size and place.
                // After a split, only one part keeps it.
                const keyedEvent = events.find((event) => {
                    const key = this.galleryGroupKeys.get(event);
                    return key !== undefined && !usedKeys.has(key);
                });
                const fresh = `gallery-${rest[0].key}`;
                const key = keyedEvent
                    ? this.galleryGroupKeys.get(keyedEvent)!
                    : usedKeys.has(fresh)
                      ? `${fresh}-${this.galleryGroupSequence++}`
                      : fresh;
                usedKeys.add(key);
                for (const event of events) this.galleryGroupKeys.set(event, key);
                // Each picture's own row comes along, so it is drawn as it would be on its own, as the old timeline
                // draws the tiles in a gallery: continuing the one before, and closing its section before a message
                // that does not continue it.
                result.push({ kind: "event-group", key, events, rows: rest, variant: "gallery" });
            }
            if (marker) result.push(marker);
        }
        return result;
    }

    /**
     * Whether an event is summed up with the events like it around it, as in the old timeline's `MainGrouper`:
     * membership and similar state changes, removed messages, events drawn only because hidden events are shown, and
     * messages a module sums up itself.
     */
    private isSummarised(event: MatrixEvent, showHiddenEvents: boolean): boolean {
        // The room's own start: drawn as a row of its own before the room's introduction, as `CreationGrouper` does.
        if (event.getType() === EventType.RoomCreate) return false;
        if (event.isState() && SUMMARISED_STATE_TYPES.has(event.getType())) return true;
        if (event.isRedacted()) return true;
        if (showHiddenEvents && !this.computeInclusion(event, true)) return true;
        return ModuleApi.instance.customComponents.getMessageRenderInfo(event)?.hasGrouping === true;
    }

    /**
     * Whether this event should get a row of its own. Re-decided on every {@link buildItems}.
     *
     * An encrypted message still being decrypted is left out for the moment. Showing one would
     * put a small placeholder in the list that grows into a full message moments later, pushing
     * everything below it down; it appears at its real size on the next rebuild instead, which
     * happens as soon as decryption finishes.
     *
     * A message that has *failed* to decrypt is different, and is shown — as the usual "unable to
     * decrypt" tile. That state can last indefinitely (the keys may never arrive), so hiding it
     * would quietly drop the message from the room rather than briefly delay it.
     *
     * Once decrypted, whether it gets a row depends on what it turned out to be: a message
     * does, but things that only modify other messages — reactions, edits — do not, matching
     * what the existing timeline shows.
     */
    private shouldIncludeEvent(event: MatrixEvent, showHiddenEvents: boolean): boolean {
        const eventId = event.getId();
        if (!eventId) return false;

        // Encrypted and still decrypting — leave it out until we know what it is. Note the
        // isDecryptionFailure check: one that has already failed is shown, not held back.
        // onEventDecrypted brings in whatever resolves later.
        if (this.isDecrypting(event)) return false;

        // Someone ignored after their messages arrived: those messages go, as in the old timeline.
        const sender = event.getSender();
        if (sender && this.opts.client.isUserIgnored(sender)) return false;

        // With hidden events shown, the old timeline gives every event a row, drawn from its source where it has no
        // tile of its own. Those that would otherwise be hidden are summed up; see {@link isSummarised}.
        if (showHiddenEvents) return !!pickFactory(event, this.opts.client, true);

        return this.computeInclusion(event, false);
    }

    private computeInclusion(event: MatrixEvent, showHiddenEvents: boolean): boolean {
        // shouldHideEvent catches edits (m.replace), poll-end events,
        // redacted-when-hidden, member events filtered by display prefs, etc.
        if (shouldHideEvent(event)) return false;

        if (!haveRendererForEvent(event, this.opts.client, showHiddenEvents)) return false;

        // Also require a concrete native factory. `haveRendererForEvent`
        // returns true if a module-registered custom-component hint exists
        // for the event (see `customComponents.getHintsForMessage`), even
        // when no native EVENT_TILE_TYPES factory matches. EventTile's
        // rendering decision uses `!!pickFactory(...)` directly though, so
        // an event in that "hinted but no factory" gap would slip into items
        // and then render as the "could not be displayed" fallback tile.
        // Custom event types like `org.element.doc.delta` fall into this
        // gap. Filtering them at the VM keeps the timeline clean.
        return !!pickFactory(event, this.opts.client, showHiddenEvents);
    }

    /**
     * Return the continuation flag for `event`, using a cached value if we
     * have already seen the event before. See `continuationCache` for why.
     *
     * Local echoes are not cached: another sender's event can arrive above one, and a cached
     * continuation would then draw our message as part of theirs.
     */
    private getCachedContinuation(eventId: string, prev: MatrixEvent | null, cur: MatrixEvent): boolean {
        const cached = this.continuationCache.get(eventId);
        if (cached !== undefined && !this.opts.room.hasPendingEvent(eventId)) return cached;
        const value = this.shouldFormContinuation(prev, cur);
        this.continuationCache.set(eventId, value);
        return value;
    }

    private shouldFormContinuation(prev: MatrixEvent | null, cur: MatrixEvent): boolean {
        if (!prev?.sender || !cur.sender) return false;
        if (cur.getTs() - prev.getTs() > RoomTimelineViewModel.CONTINUATION_MAX_INTERVAL) return false;
        if (cur.isRedacted() !== prev.isRedacted()) return false;
        const curType = cur.getType();
        const prevType = prev.getType();
        const ct = RoomTimelineViewModel.CONTINUED_TYPES;
        if (curType !== prevType && !(ct.has(curType) && ct.has(prevType))) return false;
        if (
            cur.sender.userId !== prev.sender.userId ||
            cur.sender.name !== prev.sender.name ||
            cur.sender.getMxcAvatarUrl() !== prev.sender.getMxcAvatarUrl()
        ) {
            return false;
        }
        return true;
    }

    /**
     * Merge `partial` into the snapshot with a single structured log line
     * naming the trigger (`reason`) and listing the fields that actually
     * changed. No-op merges are skipped entirely.
     *
     * Every snapshot mutation in this class goes through this helper so the
     * console gives a chronological record of view-observable state
     * transitions, attributable to the trigger that caused them. To diagnose
     * a UI jump: filter the console on `[VM-merge]` and find the merge whose
     * field changes line up with the symptom.
     */
    private mergeSnapshot(partial: Partial<RoomTimelineViewSnapshot>, reason: string): void {
        const before = this.snapshot.current;
        const changes: string[] = [];
        for (const [k, v] of Object.entries(partial)) {
            const oldV = (before as unknown as Record<string, unknown>)[k];
            if (Object.is(oldV, v)) continue;
            changes.push(formatSnapshotChange(k, oldV, v));
        }
        if (changes.length === 0) return;
        debug(`[VM-merge] reason=${reason} changes=[${changes.join(", ")}]`);
        this.snapshot.merge(partial);
    }
}

/**
 * Format a single field change for the structured merge log. Arrays show
 * only their length delta; other values show JSON before/after.
 */
function formatSnapshotChange(key: string, oldV: unknown, newV: unknown): string {
    if (Array.isArray(oldV) && Array.isArray(newV)) {
        return `${key}.length: ${oldV.length}→${newV.length}`;
    }
    return `${key}: ${JSON.stringify(oldV)}→${JSON.stringify(newV)}`;
}
