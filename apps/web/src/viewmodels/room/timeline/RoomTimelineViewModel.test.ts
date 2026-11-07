/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    Direction,
    TimelineWindow,
    EventStatus,
    EventType,
    MatrixEvent,
    MatrixEventEvent,
    PendingEventOrdering,
    ReceiptType,
    RelationType,
    Room,
    RoomEvent,
    RoomStateEvent,
    type IEventRelation,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { type TimelineItem } from "@element-hq/web-shared-components";
import { createTestClient, mkMembership, mkMessage } from "test-utils";

import SettingsStore from "../../../settings/SettingsStore";
import UserActivity from "../../../UserActivity";
import { SlidingSyncManager } from "../../../SlidingSyncManager";
import { RoomTimelineViewModel } from "./RoomTimelineViewModel";

vi.mock("../../../settings/SettingsStore");

const ROOM_ID = "!room:example.org";
const USER_ID = "@alice:example.org";
const OTHER_USER_ID = "@bob:example.org";

describe("RoomTimelineViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    let vms: RoomTimelineViewModel[];

    /** A plain text message. Pass `ts` when a test cares which day it landed on. */
    const makeMessage = (id: string, opts: { user?: string; ts?: number; msg?: string } = {}): MatrixEvent =>
        mkMessage({
            room: ROOM_ID,
            user: opts.user ?? USER_ID,
            msg: opts.msg ?? `message ${id}`,
            event: true,
            id,
            ts: opts.ts,
        });

    /**
     * A message that is encrypted and has not decrypted yet, so the view model holds it back.
     * Call the returned `decrypt()` to make it readable and fire the SDK's Decrypted event.
     */
    const makeEncryptedPending = (id: string): { event: MatrixEvent; decrypt: () => void } => {
        const event = makeMessage(id);
        let decrypted = false;
        vi.spyOn(event, "getWireType").mockReturnValue(EventType.RoomMessageEncrypted);
        vi.spyOn(event, "isEncrypted").mockReturnValue(true);
        vi.spyOn(event, "isDecryptionFailure").mockReturnValue(false);
        vi.spyOn(event, "getClearContent").mockImplementation(() => (decrypted ? { body: "secret" } : null) as any);
        return {
            event,
            decrypt: () => {
                decrypted = true;
                client.emit(MatrixEventEvent.Decrypted, event);
            },
        };
    };

    /** Put `events` into the room's live timeline, oldest first. */
    const seedTimeline = (events: MatrixEvent[]): void => {
        const timelineSet = room.getUnfilteredTimelineSet();
        for (const event of events) {
            timelineSet.addLiveEvent(event, { addToState: false });
        }
    };

    /** Construct, start, and let the async initial load settle. */
    const createStartedViewModel = async (initialEventId?: string): Promise<RoomTimelineViewModel> => {
        const vm = new RoomTimelineViewModel({ client, room, initialEventId });
        vms.push(vm);
        vm.start();
        await vi.waitFor(() => expect(vm.getSnapshot().items.length).toBeGreaterThan(0));
        return vm;
    };

    const eventKeys = (items: TimelineItem[]): string[] => items.filter((i) => i.kind === "event").map((i) => i.key);

    const kinds = (items: TimelineItem[]): string[] => items.map((i) => i.kind);

    /** Position of a message in the rendered list, which also contains date separators etc. */
    const indexOfKey = (items: TimelineItem[], key: string): number => items.findIndex((i) => i.key === key);

    beforeEach(() => {
        vms = [];
        client = createTestClient();
        room = new Room(ROOM_ID, client, USER_ID, { pendingEventOrdering: PendingEventOrdering.Detached });
        // Rooms with an open timeline are joined, except when previewing; see the read receipt tests.
        room.updateMyMembership(KnownMembership.Join);
        vi.spyOn(client, "getRoom").mockReturnValue(room);

        // The only two settings the view model reads, at their real-world defaults. A test that
        // cares about either one overrides this.
        vi.mocked(SettingsStore).getValue.mockImplementation((key): any => {
            if (key === "sendReadReceipts") return true;
            if (key === "showHiddenEventsInTimeline") return false;
            return undefined;
        });
        vi.mocked(SettingsStore).watchSetting.mockReturnValue("watch-ref");
        // The reader is at the keyboard unless a test says otherwise.
        vi.spyOn(UserActivity.sharedInstance(), "userActiveNow").mockReturnValue(true);
        vi.mocked(SettingsStore).unwatchSetting.mockImplementation(() => {});

        localStorage.clear();
    });

    afterEach(() => {
        for (const vm of vms) vm.dispose();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        localStorage.clear();
    });

    describe("lifecycle", () => {
        it("does not subscribe or load until start() is called", () => {
            // Constructing must stay side-effect free: React StrictMode builds two
            // instances and throws one away, and anything subscribed here would leak.
            // Counted on AccountData because only the view model listens for that —
            // Room.timeline also has listeners from the SDK's own timeline plumbing.
            const before = room.listenerCount(RoomEvent.AccountData);

            const vm = new RoomTimelineViewModel({ client, room });
            vms.push(vm);

            expect(room.listenerCount(RoomEvent.AccountData)).toBe(before);
            expect(vm.getSnapshot().items).toEqual([]);

            vm.start();

            expect(room.listenerCount(RoomEvent.AccountData)).toBeGreaterThan(before);
        });

        it("ignores a second start()", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const itemsAfterFirstStart = vm.getSnapshot().items;

            vm.start();

            expect(vm.getSnapshot().items).toBe(itemsAfterFirstStart);
        });

        it("ignores start() after dispose", () => {
            const vm = new RoomTimelineViewModel({ client, room });
            vms.push(vm);
            vm.dispose();

            vm.start();

            expect(vm.getSnapshot().items).toEqual([]);
        });
    });

    describe("native initial timeline preparation", () => {
        it("publishes preview rows and reloads expanded cached history without a messages request", async () => {
            const preparation = Promise.withResolvers<boolean>();
            vi.spyOn(SlidingSyncManager.instance, "initialTimelinePreparation").mockReturnValue(preparation.promise);
            seedTimeline([makeMessage("$preview")]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            const paginate = vi.spyOn(client, "paginateEventTimeline");
            const vm = await createStartedViewModel();
            expect(eventKeys(vm.getSnapshot().items)).toContain("$preview");
            vm.onAnchorReached();
            vm.onAtBottomStateChange(true);
            vm.onStartReached();
            expect(paginate).not.toHaveBeenCalled();
            room.addEventsToTimeline([makeMessage("$expanded")], true, false, room.getLiveTimeline(), "older-again");
            preparation.resolve(true);
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$expanded"));
            expect(paginate).not.toHaveBeenCalled();
        });

        it.each([false, true])("replays a deferred history request after fallback (rejected=%s)", async (rejected) => {
            const preparation = Promise.withResolvers<boolean>();
            vi.spyOn(SlidingSyncManager.instance, "initialTimelinePreparation").mockReturnValue(preparation.promise);
            seedTimeline([makeMessage("$preview")]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            const paginate = vi.spyOn(client, "paginateEventTimeline").mockImplementation(async (timeline) => {
                timeline.setPaginationToken(null, Direction.Backward);
                return false;
            });
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onStartReached();
            expect(paginate).not.toHaveBeenCalled();
            if (rejected) preparation.reject(new Error("preparation failed"));
            else preparation.resolve(false);
            await vi.waitFor(() => expect(paginate).toHaveBeenCalledTimes(1));
        });

        it("does not start initial hidden-history filling while native expansion is pending", async () => {
            const preparation = Promise.withResolvers<boolean>();
            vi.spyOn(SlidingSyncManager.instance, "initialTimelinePreparation").mockReturnValue(preparation.promise);
            seedTimeline([
                mkMembership({ room: ROOM_ID, user: OTHER_USER_ID, skey: OTHER_USER_ID, mship: "join", event: true }),
            ]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            const paginate = vi.spyOn(client, "paginateEventTimeline");
            const vm = new RoomTimelineViewModel({ client, room });
            vms.push(vm);
            vm.start();
            await Promise.resolve();
            await Promise.resolve();
            expect(paginate).not.toHaveBeenCalled();
            room.addEventsToTimeline([makeMessage("$expanded")], true, false, room.getLiveTimeline(), "older-again");
            preparation.resolve(true);
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$expanded"));
            expect(paginate).not.toHaveBeenCalled();
        });

        it("does not reload after disposal or when the reader scrolled away from the live end", async () => {
            for (const disposed of [false, true]) {
                const preparation = Promise.withResolvers<boolean>();
                vi.spyOn(SlidingSyncManager.instance, "initialTimelinePreparation").mockReturnValue(
                    preparation.promise,
                );
                seedTimeline([makeMessage(`$preview-${disposed}`)]);
                const vm = await createStartedViewModel();
                vm.onAnchorReached();
                vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);
                vm.onAtBottomStateChange(false);
                if (disposed) vm.dispose();
                const before = vm.getSnapshot();
                room.addEventsToTimeline([makeMessage(`$expanded-${disposed}`)], true, false, room.getLiveTimeline());
                preparation.resolve(true);
                await Promise.resolve();
                await Promise.resolve();
                expect(vm.getSnapshot()).toBe(before);
            }
        });

        it("shows expanded history once the reader comes back down from a jump to the unread line", async () => {
            const preparation = Promise.withResolvers<boolean>();
            vi.spyOn(SlidingSyncManager.instance, "initialTimelinePreparation").mockReturnValue(preparation.promise);
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            room.addAccountData([
                new MatrixEvent({ type: EventType.FullyRead, room_id: ROOM_ID, content: { event_id: "$a" } }),
            ]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onAtBottomStateChange(true);
            vm.jumpToReadMarker();
            vm.onAnchorReached("read-marker");
            vm.onAtBottomStateChange(false);
            // The reader scrolls back down to the newest messages before the history arrives.
            vm.onAtBottomStateChange(true);
            room.addEventsToTimeline([makeMessage("$expanded")], true, false, room.getLiveTimeline(), "older-again");
            preparation.resolve(true);
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$expanded"));
        });

        it.each([false, true])("preserves exact anchored loads (permalink=%s)", async (permalink) => {
            const prepare = vi.spyOn(SlidingSyncManager.instance, "initialTimelinePreparation");
            seedTimeline([makeMessage("$target")]);
            if (!permalink) localStorage.setItem(`timeline_scroll_${ROOM_ID}`, "$target");
            const vm = await createStartedViewModel(permalink ? "$target" : undefined);
            expect(prepare).not.toHaveBeenCalled();
            expect(vm.getSnapshot().pendingAnchor?.targetKey).toBe("$target");
        });
    });

    describe("membership summaries", () => {
        const makeMember = (id: string, ts = 1_700_000_000_000): MatrixEvent =>
            new MatrixEvent({
                event_id: id,
                room_id: ROOM_ID,
                type: EventType.RoomMember,
                sender: OTHER_USER_ID,
                state_key: `@${id.slice(1)}:example.org`,
                origin_server_ts: ts,
                content: { membership: KnownMembership.Join },
                unsigned: { prev_content: { membership: KnownMembership.Leave } },
            });
        const memberships = (count: number, prefix = "m", ts?: number): MatrixEvent[] =>
            Array.from({ length: count }, (_, i) => makeMember(`$${prefix}${i}`, ts));
        const groups = (vm: RoomTimelineViewModel) =>
            vm.getSnapshot().items.filter((item) => item.kind === "event-group");

        beforeEach(() => {
            // The generic settings API returns different value types for each key.
            vi.mocked(SettingsStore).getValue.mockImplementation((key): any => {
                if (key === "showJoinLeaves" || key === "sendReadReceipts") return true;
                if (key === "showHiddenEventsInTimeline") return false;
                return undefined;
            });
        });

        it("compacts consecutive included members while retaining messages and small runs", async () => {
            seedTimeline([
                makeMessage("$before"),
                ...memberships(5),
                makeMessage("$after"),
                ...memberships(2, "small"),
            ]);
            const vm = await createStartedViewModel();
            expect(groups(vm)).toHaveLength(1);
            expect(groups(vm)[0].events).toHaveLength(5);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$before", "$after", "$small0", "$small1"]);
        });

        it("keeps membership display preferences in force", async () => {
            vi.mocked(SettingsStore).getValue.mockReturnValue(false);
            seedTimeline([makeMessage("$message"), ...memberships(5)]);
            const vm = await createStartedViewModel();
            expect(groups(vm)).toHaveLength(0);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$message"]);
        });

        it("publishes cached conversation behind a long membership tail without fetching history", async () => {
            seedTimeline([makeMessage("$conversation"), ...memberships(90)]);
            const fetchPage = vi.spyOn(client, "paginateEventTimeline");
            const vm = await createStartedViewModel();
            expect(eventKeys(vm.getSnapshot().items)).toContain("$conversation");
            expect(groups(vm)[0].events).toHaveLength(90);
            expect(fetchPage).not.toHaveBeenCalled();
        });

        it("does not combine runs across a date boundary", async () => {
            seedTimeline([...memberships(3, "first"), ...memberships(3, "second", 1_700_000_000_000 + 86_400_000)]);
            const vm = await createStartedViewModel();
            expect(groups(vm).map((group) => group.events.length)).toEqual([3, 3]);
        });

        it("keeps a permalink member and its highlight individually addressable", async () => {
            seedTimeline(memberships(7));
            const vm = await createStartedViewModel("$m3");
            expect(eventKeys(vm.getSnapshot().items)).toContain("$m3");
            expect(groups(vm).map((group) => group.events.length)).toEqual([3, 3]);
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$m3", align: "center" });
            expect(vm.getSnapshot().highlightedEventId).toBe("$m3");
        });

        it("keeps the frozen read marker immediately after its own member event", async () => {
            seedTimeline(memberships(7));
            room.addAccountData([
                new MatrixEvent({
                    type: EventType.FullyRead,
                    room_id: ROOM_ID,
                    content: { event_id: "$m3" },
                }),
            ]);
            const vm = await createStartedViewModel();
            const items = vm.getSnapshot().items;
            expect(items[indexOfKey(items, "$m3") + 1].kind).toBe("read-marker");
            expect(groups(vm).map((group) => group.events.length)).toEqual([3, 3]);
        });

        it("keeps a restored member individually addressable", async () => {
            seedTimeline(memberships(7));
            localStorage.setItem(`timeline_scroll_${ROOM_ID}`, "$m3");
            const vm = await createStartedViewModel();
            expect(eventKeys(vm.getSnapshot().items)).toContain("$m3");
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$m3", align: "end" });
        });

        it("preserves the summary key when a live member extends it", async () => {
            seedTimeline(memberships(3));
            const vm = await createStartedViewModel();
            const key = groups(vm)[0].key;
            const event = makeMember("$new");
            room.getUnfilteredTimelineSet().addLiveEvent(event, { addToState: false });
            await vi.waitFor(() => expect(groups(vm)[0].events).toHaveLength(4));
            expect(groups(vm)[0].key).toBe(key);
        });

        it("preserves the summary key and pagination progress when older members extend it", async () => {
            seedTimeline(memberships(4));
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockImplementation(async (timeline) => {
                room.getUnfilteredTimelineSet().addEventsToTimeline(
                    memberships(3, "older").reverse(),
                    true,
                    false,
                    timeline,
                    "more-older",
                );
                return true;
            });
            const vm = await createStartedViewModel();
            const key = groups(vm)[0].key;
            vm.onAnchorReached();
            vm.onStartReached();
            await vi.waitFor(() => expect(groups(vm)[0].events).toHaveLength(7));
            expect(groups(vm)[0].key).toBe(key);
            expect(fetchPage).toHaveBeenCalledTimes(1);
        });

        it("receipts and saves the real last event represented by a visible summary", async () => {
            seedTimeline([makeMessage("$message"), ...memberships(4)]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const groupIndex = vm.getSnapshot().items.findIndex((item) => item.kind === "event-group");
            vm.onVisibleRangeChanged(groupIndex, groupIndex);
            await vi.waitFor(() => expect(client.sendReadReceipt).toHaveBeenCalled(), { timeout: 2000 });
            expect(vi.mocked(client.sendReadReceipt).mock.calls[0][0]?.getId()).toBe("$m3");
            vm.dispose();
            expect(localStorage.getItem(`timeline_scroll_${ROOM_ID}`)).toBe("$m3");
        });

        it("keeps summary identity when the SDK trims its original first event", async () => {
            seedTimeline(memberships(4));
            const vm = await createStartedViewModel();
            const key = groups(vm)[0].key;
            // Exercise the SDK's normal window trim without creating hundreds of filler events.
            (
                vm as unknown as { timelineWindow: { unpaginate: (count: number, start: boolean) => void } }
            ).timelineWindow.unpaginate(1, true);
            room.getUnfilteredTimelineSet().addLiveEvent(makeMember("$new"), { addToState: false });
            await vi.waitFor(() => expect(groups(vm)[0].events).toHaveLength(4));
            expect((groups(vm)[0].events[0] as MatrixEvent).getId()).toBe("$m1");
            expect(groups(vm)[0].key).toBe(key);
        });

        it("retains receipts associated with a grouped event for expanded child rendering", async () => {
            seedTimeline([makeMessage("$message"), ...memberships(4)]);
            const vm = await createStartedViewModel();
            room.addReceipt(
                new MatrixEvent({
                    type: EventType.Receipt,
                    content: { $m1: { [ReceiptType.Read]: { [OTHER_USER_ID]: { ts: 1000 } } } },
                }),
            );
            expect(vm.getSnapshot().readReceiptsByEvent.get("$m1")?.[0].userId).toBe(OTHER_USER_ID);
            expect(vm.getSnapshot().readReceiptsByEvent.get("$message") ?? []).toHaveLength(0);
        });
    });

    describe("initial load", () => {
        it("publishes the room's messages as event items", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);

            const vm = await createStartedViewModel();

            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "$c"]);
        });

        it("reports being at the live end when loading live", async () => {
            seedTimeline([makeMessage("$a")]);

            const vm = await createStartedViewModel();

            expect(vm.getSnapshot().atLiveEnd).toBe(true);
        });

        it("publishes cached live messages before fetching older history", async () => {
            seedTimeline([makeMessage("$cached")]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            let finishPage!: (more: boolean) => void;
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockReturnValue(
                new Promise<boolean>((resolve) => {
                    finishPage = resolve;
                }),
            );

            const vm = await createStartedViewModel();

            expect(fetchPage).not.toHaveBeenCalled();
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$cached"]);
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$cached", align: "end" });
            expect(vm.getSnapshot().alignToBottom).toBe(true);
            vm.onAnchorReached();
            vm.onStartReached();
            await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
            expect(eventKeys(vm.getSnapshot().items)).toContain("$cached");
            finishPage(false);
        });

        it("publishes the first visible live page without waiting to fill forty messages", async () => {
            seedTimeline([
                new MatrixEvent({
                    event_id: "$hidden",
                    room_id: ROOM_ID,
                    type: EventType.Reaction,
                    content: {},
                }),
            ]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockImplementation(async (timeline) => {
                room.getUnfilteredTimelineSet().addEventsToTimeline(
                    [makeMessage("$visible")],
                    true,
                    false,
                    timeline,
                    "more-older",
                );
                return true;
            });

            const vm = await createStartedViewModel();

            expect(fetchPage).toHaveBeenCalledTimes(1);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$visible"]);
            expect(vm.getSnapshot().alignToBottom).toBe(true);
        });

        it("continues backward after hidden initial pages instead of leaving the live timeline blank", async () => {
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            let page = 0;
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockImplementation(async (timeline) => {
                page++;
                const event =
                    page < 3
                        ? new MatrixEvent({
                              event_id: `$hidden${page}`,
                              room_id: ROOM_ID,
                              type: EventType.Reaction,
                              content: {},
                          })
                        : makeMessage("$visible");
                room.getUnfilteredTimelineSet().addEventsToTimeline([event], true, false, timeline, `older${page}`);
                return true;
            });
            const vm = new RoomTimelineViewModel({ client, room });
            vms.push(vm);
            vm.start();

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$visible"]));
            expect(fetchPage).toHaveBeenCalledTimes(3);
        });

        it("continues through empty server pages with valid tokens to find the first visible message", async () => {
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            let page = 0;
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockImplementation(async (timeline) => {
                page++;
                if (page <= 3) {
                    timeline.setPaginationToken(`older${page}`, Direction.Backward);
                } else {
                    room.getUnfilteredTimelineSet().addEventsToTimeline(
                        [makeMessage("$visible")],
                        true,
                        false,
                        timeline,
                        `older${page}`,
                    );
                }
                return true;
            });
            const vm = new RoomTimelineViewModel({ client, room });
            vms.push(vm);
            vm.start();

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$visible"]));
            expect(fetchPage).toHaveBeenCalledTimes(4);
        });

        it("bounds empty server pages on both sides of a permalink and preserves its anchor", async () => {
            seedTimeline([makeMessage("$target")]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            room.getLiveTimeline().setPaginationToken("newer", Direction.Forward);
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockResolvedValue(true);

            const vm = await createStartedViewModel("$target");

            expect(fetchPage.mock.calls.map(([, options]) => options?.backwards)).toEqual([true, true, false, false]);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$target"]);
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$target", align: "center" });
            expect(vm.getSnapshot().highlightedEventId).toBe("$target");
        });

        it("fills a restored position before publishing without bottom alignment", async () => {
            seedTimeline([makeMessage("$saved")]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            localStorage.setItem(`timeline_scroll_${ROOM_ID}`, "$saved");
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockResolvedValue(true);

            const vm = await createStartedViewModel();

            expect(fetchPage).toHaveBeenCalledTimes(2);
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$saved", align: "end" });
            expect(vm.getSnapshot().alignToBottom).toBe(false);
        });

        it("stops filling when disposed while a server page is pending", async () => {
            seedTimeline([makeMessage("$cached")]);
            room.getLiveTimeline().setPaginationToken("older", Direction.Backward);
            let finishPage!: (more: boolean) => void;
            const fetchPage = vi.spyOn(client, "paginateEventTimeline").mockReturnValue(
                new Promise<boolean>((resolve) => {
                    finishPage = resolve;
                }),
            );
            const vm = new RoomTimelineViewModel({ client, room, initialEventId: "$cached" });
            vms.push(vm);
            vm.start();
            await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));

            vm.dispose();
            finishPage(true);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(fetchPage).toHaveBeenCalledTimes(1);
            expect(eventKeys(vm.getSnapshot().items)).toEqual([]);
        });

        it("highlights and anchors the permalink event it was opened on", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);

            const vm = await createStartedViewModel("$b");

            const snapshot = vm.getSnapshot();
            expect(snapshot.highlightedEventId).toBe("$b");
            expect(snapshot.pendingAnchor).toEqual({ targetKey: "$b", align: "center" });
        });
    });

    describe("item projection", () => {
        it("groups consecutive messages from the same sender as continuations", async () => {
            seedTimeline([
                makeMessage("$a", { user: USER_ID }),
                makeMessage("$b", { user: USER_ID }),
                makeMessage("$c", { user: OTHER_USER_ID }),
            ]);

            const vm = await createStartedViewModel();

            const events = vm.getSnapshot().items.filter((i) => i.kind === "event");
            expect(events.map((e) => e.continuation)).toEqual([false, true, false]);
        });

        it("marks the last message of a sender's run so its group can be closed off", async () => {
            seedTimeline([
                makeMessage("$a", { user: USER_ID }),
                makeMessage("$b", { user: USER_ID }),
                makeMessage("$c", { user: OTHER_USER_ID }),
            ]);

            const vm = await createStartedViewModel();

            const events = vm.getSnapshot().items.filter((i) => i.kind === "event");
            expect(events.map((e) => e.lastInSection)).toEqual([false, true, true]);
        });

        it("separates messages sent on different days", async () => {
            const day1 = new Date("2026-03-01T10:00:00Z").getTime();
            const day2 = new Date("2026-03-02T10:00:00Z").getTime();
            seedTimeline([makeMessage("$a", { ts: day1 }), makeMessage("$b", { ts: day2 })]);

            const vm = await createStartedViewModel();

            // One separator per distinct day, each immediately before its first message.
            const items = vm.getSnapshot().items;
            const separators = items.filter((i) => i.kind === "date-separator");
            expect(separators.length).toBeGreaterThanOrEqual(1);
            const day2SeparatorIndex = items.findIndex((i) => i.kind === "date-separator" && items.indexOf(i) > 0);
            expect(items[day2SeparatorIndex + 1]?.key).toBe("$b");
        });

        it("places a read marker after the last message the user has read", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            room.addAccountData([
                new MatrixEvent({
                    type: EventType.FullyRead,
                    room_id: ROOM_ID,
                    content: { event_id: "$b" },
                }),
            ]);

            const vm = await createStartedViewModel();

            const items = vm.getSnapshot().items;
            const markerIndex = items.findIndex((i) => i.kind === "read-marker");
            expect(markerIndex).toBeGreaterThan(-1);
            expect(items[markerIndex - 1].key).toBe("$b");
        });
    });

    describe("live messages", () => {
        it("adds a message that arrives while the timeline is open", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();

            const incoming = makeMessage("$b");
            room.getUnfilteredTimelineSet().addLiveEvent(incoming, { addToState: false });
            room.emit(RoomEvent.Timeline, incoming, room, false, false, {
                timeline: room.getLiveTimeline(),
                liveEvent: true,
            } as any);

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$b"));
        });
    });

    describe("when sync replaces the live timeline", () => {
        /** Add a message to the room's current live timeline, as sync does. The SDK announces it. */
        const arrive = (event: MatrixEvent): void => {
            room.getUnfilteredTimelineSet().addLiveEvent(event, { addToState: false });
        };

        it("follows a reader at the newest messages on to the new live timeline", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onAtBottomStateChange(true);

            room.resetLiveTimeline("gap", undefined);
            arrive(makeMessage("$c", { user: OTHER_USER_ID }));

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$c"]));
            expect(vm.getSnapshot().atLiveEnd).toBe(true);
        });

        it("keeps a reader of older messages in place, counts new ones, and loads them on request", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, indexOfKey(vm.getSnapshot().items, "$a"));
            vm.onAtBottomStateChange(false);

            room.resetLiveTimeline("gap", undefined);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b"]);
            expect(vm.getSnapshot().atLiveEnd).toBe(false);

            arrive(makeMessage("$c", { user: OTHER_USER_ID }));
            await vi.waitFor(() => expect(vm.getSnapshot().numUnreadMessages).toBe(1));
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b"]);
            expect(vm.getSnapshot().atLiveEnd).toBe(false);

            vm.jumpToLive();
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$c"]));
            expect(vm.getSnapshot().atLiveEnd).toBe(true);
            expect(vm.getSnapshot().numUnreadMessages).toBe(0);
        });

        it("follows a reader of older messages on when regular sync keeps a token to the new timeline", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, indexOfKey(vm.getSnapshot().items, "$a"));
            vm.onAtBottomStateChange(false);

            // Regular sync keeps the old timeline, with a forward token leading to the new one.
            const timelineSet = room.getUnfilteredTimelineSet();
            const old = timelineSet.getLiveTimeline();
            timelineSet.resetLiveTimeline("back", "forward");
            const live = timelineSet.getLiveTimeline();
            expect(vm.getSnapshot().atLiveEnd).toBe(false);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b"]);
            // Paginating forward from the old timeline reaches the new live one, as the SDK links them.
            vi.mocked(client.paginateEventTimeline).mockImplementation(async (timeline) => {
                if (timeline !== old) return false;
                old.setNeighbouringTimeline(live, Direction.Forward);
                live.setNeighbouringTimeline(old, Direction.Backward);
                old.setPaginationToken(null, Direction.Forward);
                return true;
            });

            timelineSet.addLiveEvent(makeMessage("$c", { user: OTHER_USER_ID }), { addToState: false });
            await vi.waitFor(() => expect(vm.getSnapshot().numUnreadMessages).toBe(1));
            // Scrolling to the end pages forward through the gap into the new live timeline.
            vm.onEndReached();
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "$c"]));
            await vi.waitFor(() => expect(vm.getSnapshot().atLiveEnd).toBe(true));
            // And keeps following new messages afterwards.
            timelineSet.addLiveEvent(makeMessage("$d", { user: OTHER_USER_ID }), { addToState: false });
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$d"));
        });

        it("ignores resets of other timeline sets", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const items = vm.getSnapshot().items;
            const thread = room.getUnfilteredTimelineSet();
            room.emit(RoomEvent.TimelineReset, room, { ...thread } as any, true);
            expect(vm.getSnapshot().items).toBe(items);
        });
    });

    describe("requests from the room view", () => {
        it("scrolls to the newest loaded message, or loads the live end first", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.jumpToLive();
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$b", align: "end" });
            vm.onAnchorReached();
            expect(vm.getSnapshot().pendingAnchor).toBeNull();
        });

        it("shows and highlights a message in the open room, loading it when it is not in the window", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();

            vm.showEvent("$a");
            expect(vm.getSnapshot().highlightedEventId).toBe("$a");
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$a", align: "center" });

            vm.onAnchorReached();
            const load = vi.spyOn(TimelineWindow.prototype, "load").mockResolvedValue(undefined);
            vm.showEvent("$elsewhere");
            expect(load).toHaveBeenCalledWith("$elsewhere", expect.any(Number));
        });

        it("follows on after a sync gap once the reader has scrolled from a navigated message back to the newest", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.showEvent("$a");
            vm.onAnchorReached("$a");
            // While the placement is pending, reaching the bottom does not forget the navigation.
            vm.onAtBottomStateChange(false);
            // The reader scrolls back down to the newest message themselves.
            vm.onAtBottomStateChange(true);

            room.resetLiveTimeline("gap", undefined);
            room.getUnfilteredTimelineSet().addLiveEvent(makeMessage("$c"), { addToState: false });
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$c"]));
        });

        it("keeps going to an older message when a sync gap arrives on the way", async () => {
            const events = Array.from({ length: 250 }, (_, i) => makeMessage(`$m${i}`));
            seedTimeline(events);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onAtBottomStateChange(true);
            const realLoad = TimelineWindow.prototype.load;
            const slow = Promise.withResolvers<void>();
            vi.spyOn(TimelineWindow.prototype, "load").mockImplementation(async function (
                this: TimelineWindow,
                eventId?: string,
                size?: number,
            ) {
                await realLoad.call(this, eventId, size);
                if (eventId === "$m0") await slow.promise;
            });
            vm.showEvent("$m0");
            // A gap in sync after the message is found, while the load is still running.
            await vi.waitFor(() =>
                expect(TimelineWindow.prototype.load).toHaveBeenCalledWith("$m0", expect.any(Number)),
            );
            room.resetLiveTimeline("gap", undefined);
            slow.resolve();
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$m0"));
            expect(vm.getSnapshot().highlightedEventId).toBe("$m0");
        });

        it("keeps the unread line or a loaded message it is moving to when a sync gap arrives first", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            room.addAccountData([
                new MatrixEvent({ type: EventType.FullyRead, room_id: ROOM_ID, content: { event_id: "$a" } }),
            ]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onAtBottomStateChange(true);

            vm.jumpToReadMarker();
            room.resetLiveTimeline("gap", undefined);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "read-marker", align: "center" });
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "$c"]);
            expect(vm.getSnapshot().atLiveEnd).toBe(false);
        });

        it("keeps a loaded message it brings into view when a sync gap arrives before it is placed", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const items = vm.getSnapshot().items;
            vm.onVisibleRangeChanged(indexOfKey(items, "$b"), indexOfKey(items, "$c"));
            vm.onAtBottomStateChange(true);

            vm.scrollToEventIfNeeded("$a");
            room.resetLiveTimeline("gap", undefined);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$a", align: "center" });
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "$c"]);
        });

        it("keeps a message navigated to in a short room while native history is still being expanded", async () => {
            const preparation = Promise.withResolvers<boolean>();
            vi.spyOn(SlidingSyncManager.instance, "initialTimelinePreparation").mockReturnValue(preparation.promise);
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.showEvent("$a");
            vm.onAnchorReached("$a");
            // The whole room fits on screen, so the list reports reaching the bottom by itself.
            vm.onAtBottomStateChange(true);
            preparation.resolve(true);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(vm.getSnapshot().highlightedEventId).toBe("$a");
        });

        it("forgets an abandoned navigation when the jump-to-latest button is used", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const realLoad = TimelineWindow.prototype.load;
            const slow = Promise.withResolvers<void>();
            vi.spyOn(TimelineWindow.prototype, "load").mockImplementation(async function (
                this: TimelineWindow,
                eventId?: string,
                size?: number,
            ) {
                if (eventId === "$elsewhere") await slow.promise;
                return realLoad.call(this, eventId, size);
            });
            vm.showEvent("$elsewhere");
            const scrollNow = vi.fn();
            vm.onJumpToLive(scrollNow);
            expect(scrollNow).toHaveBeenCalledWith({ targetKey: "$b", align: "end" });
            expect(vm.getSnapshot().highlightedEventId).toBeNull();

            // The reader is at the newest messages again, so a gap in sync follows them on.
            vm.onAtBottomStateChange(true);
            room.resetLiveTimeline("gap", undefined);
            room.getUnfilteredTimelineSet().addLiveEvent(makeMessage("$c"), { addToState: false });
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$c"]));
            slow.resolve();
        });

        it("keeps a message navigated to while the first placement settles", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            const initial = vm.getSnapshot().pendingAnchor!;
            vm.showEvent("$a");
            // The view reports the placement it started, for the earlier anchor.
            vm.onAnchorReached(initial.targetKey);
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$a", align: "center" });
            vm.onAnchorReached("$a");
            expect(vm.getSnapshot().pendingAnchor).toBeNull();
        });

        it("brings a loaded message into view only when it is not visible", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const items = vm.getSnapshot().items;
            vm.onVisibleRangeChanged(indexOfKey(items, "$b"), indexOfKey(items, "$c"));

            vm.scrollToEventIfNeeded("$c");
            vm.scrollToEventIfNeeded("$unknown");
            expect(vm.getSnapshot().pendingAnchor).toBeNull();

            vm.scrollToEventIfNeeded("$a");
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$a", align: "center" });
        });

        it("reports whether the reader is at the newest message", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            expect(vm.isAtLiveBottom).toBe(false);
            vm.onAtBottomStateChange(true);
            expect(vm.isAtLiveBottom).toBe(true);
            expect(vm.canJumpToReadMarker).toBe(false);
        });

        it("sends a receipt straight away when asked, such as when the window regains focus", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);
            vm.sendReadReceiptNow();
            expect(client.sendReadReceipt).toHaveBeenCalledTimes(1);
            expect(vi.mocked(client.sendReadReceipt).mock.calls[0][0]?.getId()).toBe("$b");
        });

        it("keeps a newer load's window when an older load of other messages finishes later", async () => {
            // More than one window holds, so the permalink's window and the live one differ.
            const events = Array.from({ length: 250 }, (_, i) => makeMessage(`$m${i}`));
            seedTimeline(events);
            const vm = new RoomTimelineViewModel({ client, room, initialEventId: "$m0" });
            vms.push(vm);
            const realLoad = TimelineWindow.prototype.load;
            const permalink = Promise.withResolvers<void>();
            vi.spyOn(TimelineWindow.prototype, "load").mockImplementation(async function (
                this: TimelineWindow,
                eventId?: string,
                size?: number,
            ) {
                if (eventId === "$m0") await permalink.promise;
                return realLoad.call(this, eventId, size);
            });
            vm.start();
            vm.jumpToLive();
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$m249"));
            vm.onAnchorReached();

            permalink.resolve();
            await new Promise((resolve) => setTimeout(resolve, 10));
            // A new live message still extends the live window, not the old permalink's.
            room.getUnfilteredTimelineSet().addLiveEvent(makeMessage("$new"), { addToState: false });
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$new"));
            expect(eventKeys(vm.getSnapshot().items)).not.toContain("$m0");
            expect(vm.getSnapshot().highlightedEventId).toBeNull();
        });

        it("cancels a slower load when the reader navigates to messages already shown", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const realLoad = TimelineWindow.prototype.load;
            const elsewhere = Promise.withResolvers<void>();
            vi.spyOn(TimelineWindow.prototype, "load").mockImplementation(async function (
                this: TimelineWindow,
                eventId?: string,
                size?: number,
            ) {
                if (eventId === "$elsewhere") await elsewhere.promise;
                return realLoad.call(this, eventId === "$elsewhere" ? undefined : eventId, size);
            });
            vm.showEvent("$elsewhere");
            // The reader presses Escape before that message has loaded.
            vm.jumpToLive();
            expect(vm.getSnapshot().pendingAnchor).toEqual({ targetKey: "$b", align: "end" });
            vm.onAnchorReached("$b");

            elsewhere.resolve();
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(vm.getSnapshot().highlightedEventId).toBeNull();
            expect(vm.getSnapshot().pendingAnchor).toBeNull();
        });

        it("does not let an overtaken load replace a newer one", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = new RoomTimelineViewModel({ client, room, initialEventId: "$a" });
            vms.push(vm);
            const window = (vm as any).timelineWindow;
            const realLoad = window.load.bind(window);
            const permalink = Promise.withResolvers<void>();
            vi.spyOn(window, "load").mockImplementation(async (eventId?: unknown, size?: unknown) => {
                if (eventId === "$a") await permalink.promise;
                return realLoad(eventId, size);
            });
            vm.start();
            // The reader jumps to the latest messages before the permalink has loaded.
            vm.jumpToLive();
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b"]));
            expect(vm.getSnapshot().highlightedEventId).toBeNull();

            permalink.resolve();
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(vm.getSnapshot().highlightedEventId).toBeNull();
            expect(vm.getSnapshot().pendingAnchor).not.toEqual({ targetKey: "$a", align: "center" });
        });
    });

    describe("pagination", () => {
        it("asks for older messages when the top of the list is reached", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            // Pagination is suppressed until the initial placement settles, so report
            // that first — as the view does before the user can scroll.
            vm.onAnchorReached();
            const paginate = vi.spyOn((vm as any).timelineWindow, "paginate").mockResolvedValue(false);
            vi.spyOn((vm as any).timelineWindow, "canPaginate").mockImplementation(
                (...args: unknown[]) => args[0] === Direction.Backward,
            );

            vm.onStartReached();

            await vi.waitFor(() =>
                expect(paginate).toHaveBeenCalledWith(Direction.Backward, expect.any(Number), true, 1),
            );
        });

        it("does not ask for older messages once the start of the room is loaded", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const paginate = vi.spyOn((vm as any).timelineWindow, "paginate").mockResolvedValue(false);
            vi.spyOn((vm as any).timelineWindow, "canPaginate").mockReturnValue(false);

            vm.onStartReached();

            expect(paginate).not.toHaveBeenCalled();
        });

        it("shows a loading spinner in the list while older messages are fetched", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            let resolvePaginate: (v: boolean) => void = () => {};
            vi.spyOn((vm as any).timelineWindow, "paginate").mockReturnValue(
                new Promise<boolean>((resolve) => {
                    resolvePaginate = resolve;
                }),
            );
            vi.spyOn((vm as any).timelineWindow, "canPaginate").mockImplementation(
                (...args: unknown[]) => args[0] === Direction.Backward,
            );

            vm.onStartReached();

            // The spinner is a real list item so it reserves scroll space.
            await vi.waitFor(() => expect(kinds(vm.getSnapshot().items)).toContain("loading"));
            resolvePaginate(false);
        });
    });

    describe("pagination (continued)", () => {
        /** Point the window's paginate/canPaginate at test doubles. */
        const stubWindow = (
            vm: RoomTimelineViewModel,
            opts: { canPaginate: Direction[]; paginate?: () => Promise<boolean> },
        ): { paginate: ReturnType<typeof vi.fn> } => {
            const tw = (vm as any).timelineWindow;
            const paginate = vi.fn(opts.paginate ?? (() => Promise.resolve(false)));
            vi.spyOn(tw, "paginate").mockImplementation(paginate);
            vi.spyOn(tw, "canPaginate").mockImplementation((...args: unknown[]) =>
                opts.canPaginate.includes(args[0] as Direction),
            );
            return { paginate };
        };

        it("asks for newer messages when the bottom of the list is reached", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const { paginate } = stubWindow(vm, { canPaginate: [Direction.Forward] });

            vm.onEndReached();

            await vi.waitFor(() =>
                expect(paginate).toHaveBeenCalledWith(Direction.Forward, expect.any(Number), true, 1),
            );
        });

        it("does not ask for newer messages once the latest is loaded", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const { paginate } = stubWindow(vm, { canPaginate: [] });

            vm.onEndReached();

            expect(paginate).not.toHaveBeenCalled();
        });

        it("re-runs a fetch for an edge report that arrived while one was already in flight", async () => {
            // The view only reports reaching the end when something has changed, and what
            // it compares can look the same either side of a fetch — so it may never ask
            // again. Dropping the request would leave the timeline stuck at the top.
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            let release!: () => void;
            const gate = new Promise<boolean>((resolve) => {
                release = () => resolve(false);
            });
            let calls = 0;
            const { paginate } = stubWindow(vm, {
                canPaginate: [Direction.Backward],
                paginate: () => (++calls === 1 ? gate : Promise.resolve(false)),
            });

            vm.onStartReached();
            await vi.waitFor(() => expect(paginate).toHaveBeenCalledTimes(1));
            vm.onStartReached(); // lands while the first fetch is still running
            release(); // first fetch settles, having found nothing new

            // Empty pages retain a continuation token: each chain exhausts its bounded
            // eleven attempts, and the queued edge report runs one more bounded chain.
            await vi.waitFor(() => expect(paginate).toHaveBeenCalledTimes(22));
        });

        it("clears the spinner when fetching fails", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            stubWindow(vm, {
                canPaginate: [Direction.Backward],
                paginate: () => Promise.reject(new Error("network went away")),
            });

            vm.onStartReached();

            // The failure must not leave a spinner stuck in the list forever.
            await vi.waitFor(() => expect(kinds(vm.getSnapshot().items)).not.toContain("loading"));
        });

        it("waits for a fetched message to decrypt before showing it", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();

            const tw = (vm as any).timelineWindow;
            const existing = tw.getEvents();
            const { event: encrypted, decrypt } = makeEncryptedPending("$enc");
            let fetched = false;
            vi.spyOn(tw, "canPaginate").mockImplementation((...a: unknown[]) => a[0] === Direction.Backward);
            vi.spyOn(tw, "paginate").mockImplementation(async () => {
                fetched = true;
                return false;
            });
            vi.spyOn(tw, "getEvents").mockImplementation(() => (fetched ? [encrypted, ...existing] : existing));

            vm.onStartReached();
            // Let the fetch land, then decrypt while the view model is still waiting on it.
            await vi.waitFor(() => expect(fetched).toBe(true));
            decrypt();

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$enc"));
        });
    });

    describe("scroll reporting", () => {
        it("clears the pending anchor once the view reports it has arrived", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel("$a");
            expect(vm.getSnapshot().pendingAnchor).not.toBeNull();

            vm.onAnchorReached();

            expect(vm.getSnapshot().pendingAnchor).toBeNull();
        });

        it("tracks whether the view is scrolled to the bottom", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();

            vm.onAtBottomStateChange(true);
            expect(vm.getSnapshot().isAtBottom).toBe(true);

            vm.onAtBottomStateChange(false);
            expect(vm.getSnapshot().isAtBottom).toBe(false);
        });
    });

    describe("jumping to the latest message", () => {
        it("scrolls straight there when the newest message is already loaded", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const scrollNow = vi.fn();

            vm.onJumpToLive(scrollNow);

            // Already at the live end, so no reload is needed — scroll immediately.
            expect(scrollNow).toHaveBeenCalledWith({ targetKey: "$b", align: "end" });
        });
    });

    describe("read marker", () => {
        it("offers a jump when there are unread messages below the viewport", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            room.addAccountData([
                new MatrixEvent({
                    type: EventType.FullyRead,
                    room_id: ROOM_ID,
                    content: { event_id: "$a" },
                }),
            ]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();

            // Viewport sitting on the first row only, so the marker is below it.
            vm.onVisibleRangeChanged(0, 0);

            expect(vm.getSnapshot().canJumpToReadMarker).toBe("below");
        });

        it("scrolls straight to the marker when it is already loaded", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            room.addAccountData([
                new MatrixEvent({
                    type: EventType.FullyRead,
                    room_id: ROOM_ID,
                    content: { event_id: "$b" },
                }),
            ]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const scrollNow = vi.fn();

            vm.onJumpToReadMarker(scrollNow);

            expect(scrollNow).toHaveBeenCalledWith(expect.objectContaining({ targetKey: "read-marker" }));
            // The reader is now reading at the marker, so a gap in sync keeps them there.
            vm.onAtBottomStateChange(false);
            room.resetLiveTimeline("gap", undefined);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "$c"]);
        });

        it("offers a jump when the marker is older than the loaded messages", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            room.addAccountData([
                new MatrixEvent({ type: EventType.FullyRead, room_id: ROOM_ID, content: { event_id: "$gone" } }),
            ]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            // The marker is not among the loaded messages, and there is older history behind us.
            const tw = (vm as any).timelineWindow;
            vi.spyOn(tw, "canPaginate").mockImplementation((...a: unknown[]) => a[0] === Direction.Backward);

            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);

            expect(vm.getSnapshot().canJumpToReadMarker).toBe("above");
        });

        it("reloads the timeline when the marker is not loaded", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            room.addAccountData([
                new MatrixEvent({ type: EventType.FullyRead, room_id: ROOM_ID, content: { event_id: "$b" } }),
            ]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            // Marker exists but its row is not in the list, so it cannot simply be scrolled to.
            (vm as any).baseItems = [];
            (vm as any).republish("test");
            const scrollNow = vi.fn();

            vm.onJumpToReadMarker(scrollNow);

            // Falls back to fetching around the marker rather than scrolling nowhere.
            expect(scrollNow).not.toHaveBeenCalled();
        });

        it("removes the marker when everything is marked as read", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            room.addAccountData([
                new MatrixEvent({
                    type: EventType.FullyRead,
                    room_id: ROOM_ID,
                    content: { event_id: "$a" },
                }),
            ]);
            const vm = await createStartedViewModel();
            expect(kinds(vm.getSnapshot().items)).toContain("read-marker");

            vm.onMarkAllAsRead();

            await vi.waitFor(() => expect(kinds(vm.getSnapshot().items)).not.toContain("read-marker"));
        });
    });

    describe("decryption", () => {
        it("holds back a message that has not decrypted yet", async () => {
            const { event } = makeEncryptedPending("$enc");
            seedTimeline([makeMessage("$a"), event]);

            const vm = await createStartedViewModel();

            expect(eventKeys(vm.getSnapshot().items)).not.toContain("$enc");
        });

        it("shows it once it decrypts, without needing a scroll or a new message", async () => {
            const { event, decrypt } = makeEncryptedPending("$enc");
            seedTimeline([makeMessage("$a"), event]);
            const vm = await createStartedViewModel();
            expect(eventKeys(vm.getSnapshot().items)).not.toContain("$enc");

            decrypt();

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$enc"));
        });

        it("shows a message that failed to decrypt rather than hiding it", async () => {
            // A failure may never resolve, so hiding it would silently drop the message.
            const failed = makeMessage("$utd");
            vi.spyOn(failed, "getWireType").mockReturnValue(EventType.RoomMessageEncrypted);
            vi.spyOn(failed, "isEncrypted").mockReturnValue(true);
            vi.spyOn(failed, "isDecryptionFailure").mockReturnValue(true);
            seedTimeline([makeMessage("$a"), failed]);

            const vm = await createStartedViewModel();

            expect(eventKeys(vm.getSnapshot().items)).toContain("$utd");
        });

        it("ignores decryption of a message outside the loaded window", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const before = vm.getSnapshot().items;

            const stranger = makeMessage("$elsewhere");
            client.emit(MatrixEventEvent.Decrypted, stranger);

            expect(vm.getSnapshot().items).toBe(before);
        });
    });

    describe("read receipts", () => {
        const flushReceiptDebounce = async (): Promise<void> => {
            await vi.waitFor(() => expect(client.sendReadReceipt).toHaveBeenCalled(), { timeout: 2000 });
        };

        it("sends a receipt for the bottommost visible message", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();

            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);

            await flushReceiptDebounce();
            const [receiptedEvent, receiptType] = vi.mocked(client.sendReadReceipt).mock.calls[0];
            expect(receiptedEvent?.getId()).toBe("$b");
            expect(receiptType).toBe(ReceiptType.Read);
        });

        it("sends a private receipt when the user has read receipts turned off", async () => {
            vi.mocked(SettingsStore).getValue.mockImplementation((key): any => {
                if (key === "sendReadReceipts") return false;
                if (key === "showHiddenEventsInTimeline") return false;
                return undefined;
            });
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();

            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);

            await flushReceiptDebounce();
            expect(client.sendReadReceipt).toHaveBeenCalledWith(expect.anything(), ReceiptType.ReadPrivate);
        });

        it("does not send receipts in a room the user has not joined, such as one being previewed", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            room.updateMyMembership(KnownMembership.Leave);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);
            vm.sendReadReceiptNow();
            await new Promise((r) => setTimeout(r, 700));
            expect(client.sendReadReceipt).not.toHaveBeenCalled();
        });

        it("holds receipts back while the user is away, and sends them once they are back", async () => {
            const activity = UserActivity.sharedInstance();
            vi.mocked(activity.userActiveNow).mockReturnValue(false);
            let activeTimer: { start: () => void } | undefined;
            vi.spyOn(activity, "timeWhileActiveNow").mockImplementation((timer) => {
                activeTimer = timer;
            });
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);
            await new Promise((r) => setTimeout(r, 700));
            expect(client.sendReadReceipt).not.toHaveBeenCalled();

            vi.mocked(activity.userActiveNow).mockReturnValue(true);
            activeTimer!.start();
            await vi.waitFor(() => expect(client.sendReadReceipt).toHaveBeenCalledTimes(1), { timeout: 2000 });
            expect(vi.mocked(client.sendReadReceipt).mock.calls[0][0]?.getId()).toBe("$b");
        });

        it("waits for the user again when they go inactive before the held-back receipt is sent", async () => {
            const activity = UserActivity.sharedInstance();
            vi.mocked(activity.userActiveNow).mockReturnValue(false);
            const waits: { start: () => unknown; abort: () => unknown }[] = [];
            vi.spyOn(activity, "timeWhileActiveNow").mockImplementation((timer) => {
                waits.push(timer);
            });
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);
            await vi.waitFor(() => expect(waits).toHaveLength(1), { timeout: 2000 });

            // Activity starts the wait, then stops before it is over, as UserActivity does.
            waits[0].start();
            waits[0].abort();
            await vi.waitFor(() => expect(waits).toHaveLength(2));
            vi.mocked(activity.userActiveNow).mockReturnValue(true);
            waits[1].start();
            await vi.waitFor(() => expect(client.sendReadReceipt).toHaveBeenCalledTimes(1), { timeout: 2000 });
        });

        it("lets go of a receipt wait that never started when it is disposed", async () => {
            const activity = UserActivity.sharedInstance();
            vi.mocked(activity.userActiveNow).mockReturnValue(false);
            const waits: { finished: () => Promise<void> }[] = [];
            vi.spyOn(activity, "timeWhileActiveNow").mockImplementation((timer) => {
                waits.push(timer);
            });
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);
            await vi.waitFor(() => expect(waits).toHaveLength(1), { timeout: 2000 });
            const settled = waits[0].finished();
            vm.dispose();
            await expect(settled).rejects.toThrow();
            expect(waits).toHaveLength(1);
        });

        it("does not move the receipt backwards when the user scrolls up", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const items = vm.getSnapshot().items;

            vm.onVisibleRangeChanged(0, items.length - 1);
            await flushReceiptDebounce();
            const callsAfterBottom = vi.mocked(client.sendReadReceipt).mock.calls.length;

            // Scroll back up: the bottommost visible message is now an older one.
            vm.onVisibleRangeChanged(0, 0);
            await new Promise((r) => setTimeout(r, 700));

            expect(vi.mocked(client.sendReadReceipt).mock.calls.length).toBe(callsAfterBottom);
        });
    });

    describe("dispose", () => {
        it("stops listening to the room", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const before = room.listenerCount(RoomEvent.Timeline);
            const receiptListenersBefore = room.listenerCount(RoomEvent.Receipt);

            vm.dispose();

            expect(room.listenerCount(RoomEvent.Timeline)).toBeLessThan(before);
            expect(room.listenerCount(RoomEvent.Receipt)).toBeLessThan(receiptListenersBefore);
        });

        it("remembers where the reader got to, so the next visit resumes there", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b"), makeMessage("$c")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onAtBottomStateChange(false);
            vm.onVisibleRangeChanged(0, indexOfKey(vm.getSnapshot().items, "$b"));

            vm.dispose();

            expect(localStorage.getItem(`timeline_scroll_${ROOM_ID}`)).toBe("$b");
        });

        it("forgets the position when the reader was already at the bottom", async () => {
            localStorage.setItem(`timeline_scroll_${ROOM_ID}`, "$a");
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);
            vm.onAtBottomStateChange(true);

            vm.dispose();

            // Nothing saved means the next visit starts at the newest message.
            expect(localStorage.getItem(`timeline_scroll_${ROOM_ID}`)).toBeNull();
        });

        it("moves the unread marker to what the reader actually saw", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            vm.onVisibleRangeChanged(0, indexOfKey(vm.getSnapshot().items, "$b"));

            vm.dispose();

            expect(client.setRoomReadMarkers).toHaveBeenCalledWith(ROOM_ID, "$b");
        });

        it("leaves a saved position alone when nothing was ever visible", async () => {
            localStorage.setItem(`timeline_scroll_${ROOM_ID}`, "$a");
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();

            vm.dispose();

            expect(localStorage.getItem(`timeline_scroll_${ROOM_ID}`)).toBe("$a");
        });

        it("ignores late events that arrive after disposal", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.dispose();
            const itemsAtDispose = vm.getSnapshot().items;

            const late = makeMessage("$late");
            room.getUnfilteredTimelineSet().addLiveEvent(late, { addToState: false });
            room.emit(RoomEvent.Timeline, late, room, false, false, {
                timeline: room.getLiveTimeline(),
                liveEvent: true,
            } as any);

            expect(vm.getSnapshot().items).toBe(itemsAtDispose);
        });
    });

    describe("messages being sent", () => {
        /** Put a message of ours into the room's pending list, as the SDK does when the composer sends. */
        const addPendingMessage = (id: string, opts: { ts?: number; relatesTo?: IEventRelation } = {}): MatrixEvent => {
            const txnId = `txn-${id}`;
            const event = mkMessage({
                room: ROOM_ID,
                user: USER_ID,
                msg: `message ${id}`,
                event: true,
                id,
                ts: opts.ts,
                relatesTo: opts.relatesTo,
            });
            event.setTxnId(txnId);
            event.setStatus(EventStatus.SENDING);
            room.addPendingEvent(event, txnId);
            return event;
        };

        /**
         * Deliver the server's copy of a pending message, as /sync would. The SDK matches it to
         * the pending message by transaction id, drops that from the pending list, moves it into
         * the timeline under its server id, and only then announces the local echo changed.
         */
        const receiveRemoteEcho = async (pending: MatrixEvent, serverId: string, ts?: number): Promise<void> => {
            const echo = makeMessage(serverId, { msg: pending.getContent().body, ts });
            echo.setUnsigned({ ...echo.getUnsigned(), transaction_id: pending.getTxnId() });
            await room.addLiveEvents([echo], { addToState: false });
        };

        /** Give any queued rebuild the chance to run. */
        const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

        const eventRow = (
            vm: RoomTimelineViewModel,
            key: string,
        ): Extract<TimelineItem, { kind: "event" }> | undefined =>
            vm
                .getSnapshot()
                .items.find((i): i is Extract<TimelineItem, { kind: "event" }> => i.kind === "event" && i.key === key);

        beforeEach(() => {
            // The messages being sent are ours, as they are in the app.
            vi.mocked(client.getSafeUserId).mockReturnValue(USER_ID);
        });

        it("shows a send failure that happened while an abandoned load was running", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const pending = addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventRow(vm, "~pending")?.sendState).toBe("sending"));
            const realLoad = TimelineWindow.prototype.load;
            const slow = Promise.withResolvers<void>();
            vi.spyOn(TimelineWindow.prototype, "load").mockImplementation(async function (
                this: TimelineWindow,
                eventId?: string,
                size?: number,
            ) {
                if (eventId === "$elsewhere") await slow.promise;
                return realLoad.call(this, eventId === "$elsewhere" ? undefined : eventId, size);
            });
            vm.showEvent("$elsewhere");
            room.updatePendingEvent(pending, EventStatus.NOT_SENT);
            await settle();
            // The reader presses Escape while that load is still running.
            vm.jumpToLive();
            await vi.waitFor(() => expect(eventRow(vm, "~pending")?.sendState).toBe("failed"));
            slow.resolve();
        });

        it("shows a message as soon as it leaves the composer, after the confirmed ones", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            // Nothing arrives from the server here: the row has to come from the room's pending list.
            const timelineEvents = vi.fn();
            room.on(RoomEvent.Timeline, timelineEvents);

            const pending = addPendingMessage("~pending");

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "~pending"]));
            expect(timelineEvents).not.toHaveBeenCalled();
            expect(pending.status).toBe(EventStatus.SENDING);
            expect(eventRow(vm, "~pending")?.sendState).toBe("sending");
            expect(eventRow(vm, "$a")?.sendState).toBeUndefined();
            // The row carries the message itself, so the view need not look it up in the room.
            expect(eventRow(vm, "~pending")?.event).toBe(pending);
            // Our own message is not unread, and the newest messages are still the ones loaded.
            expect(vm.getSnapshot().numUnreadMessages).toBe(0);
            expect(vm.getSnapshot().atLiveEnd).toBe(true);
        });

        it("moves the 'Sent' tick onto a message being sent once the server accepts it", async () => {
            seedTimeline([makeMessage("$a", { user: USER_ID })]);
            const vm = await createStartedViewModel();
            expect(vm.getSnapshot().lastSuccessfulEventId).toBe("$a");

            // Still on its way: the tick stays on the message the server has.
            const pending = addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "~pending"]));
            expect(vm.getSnapshot().lastSuccessfulEventId).toBe("$a");

            // Accepted but not yet echoed: the message is still pending, under its server id, and takes the tick.
            room.updatePendingEvent(pending, EventStatus.SENT, "$real");
            await vi.waitFor(() => expect(vm.getSnapshot().lastSuccessfulEventId).toBe("$real"));
            expect(room.getPendingEvents()).toContain(pending);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$real"]);
        });

        it("keeps a message being sent below one that arrives meanwhile, as the old timeline does", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const pending = addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "~pending"]));

            // Someone else's message reaches the timeline while ours is still on its way.
            await room.addLiveEvents([makeMessage("$b", { user: OTHER_USER_ID })], { addToState: false });
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "~pending"]));

            // Once the server has ours, it takes its place in the timeline's order.
            await receiveRemoteEcho(pending, "$real");
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "$real"]));
        });

        it("recomputes a local echo's continuation when another sender's event lands above it", async () => {
            const sentAt = new Date("2026-03-01T10:00:00Z").getTime();
            seedTimeline([makeMessage("$a", { ts: sentAt })]);
            const vm = await createStartedViewModel();
            // Sent straight after our own $a, so at first it continues it.
            const pending = addPendingMessage("~pending", { ts: sentAt + 1000 });
            await vi.waitFor(() => expect(eventRow(vm, "~pending")?.continuation).toBe(true));

            // Someone else's message now sits between the two of ours. Drawn as a continuation,
            // ours would show no name under theirs, as if they had written it.
            await room.addLiveEvents([makeMessage("$b", { user: OTHER_USER_ID, ts: sentAt + 500 })], {
                addToState: false,
            });
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "~pending"]));
            expect(eventRow(vm, "~pending")?.continuation).toBe(false);
            expect(eventRow(vm, "$b")?.lastInSection).toBe(true);

            // And it keeps our name once the server has it.
            await receiveRemoteEcho(pending, "$real", sentAt + 1000);
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$b", "$real"]));
            expect(eventRow(vm, "$real")?.continuation).toBe(false);
        });

        it("shows a message that was already pending when the room was opened", async () => {
            // Pending messages survive a reload (the SDK restores them from storage), so one can be
            // there before the first load has run; that load has to pick it up itself.
            seedTimeline([makeMessage("$a")]);
            addPendingMessage("~pending");

            const vm = await createStartedViewModel();

            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "~pending"]);
        });

        it("does not mix a message being sent into old history", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            // The reader has scrolled back so far that the newest messages are no longer loaded.
            vi.spyOn((vm as any).timelineWindow, "canPaginate").mockImplementation(
                (...args: unknown[]) => args[0] === Direction.Forward,
            );

            addPendingMessage("~pending");
            await settle();

            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a"]);
        });

        it("does not give a pending edit a row of its own", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();

            addPendingMessage("~edit", { relatesTo: { rel_type: RelationType.Replace, event_id: "$a" } });
            await settle();

            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a"]);
        });

        it("does not show a thread reply being sent in the main timeline", async () => {
            vi.mocked(client.supportsThreads).mockReturnValue(true);
            seedTimeline([makeMessage("$root")]);
            const vm = await createStartedViewModel();

            addPendingMessage("~reply", { relatesTo: { rel_type: RelationType.Thread, event_id: "$root" } });
            addPendingMessage("~pending");

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("~pending"));
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$root", "~pending"]);
        });

        it("swaps the local id for the server's when the echo arrives, without the row ever going missing", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const pending = addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("~pending"));

            const published: string[][] = [];
            vm.subscribe(() => published.push(eventKeys(vm.getSnapshot().items)));

            await receiveRemoteEcho(pending, "$real");

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$real"]));
            expect(room.getPendingEvents()).toEqual([]);
            expect(eventRow(vm, "$real")?.sendState).toBeUndefined();
            // The SDK turns our copy into the server's in place, so the row keeps the same object.
            expect(eventRow(vm, "$real")?.event).toBe(pending);
            // Every publish along the way kept exactly one row for the message: it never
            // disappeared, and it was never drawn twice under both ids.
            expect(published.length).toBeGreaterThanOrEqual(1);
            for (const keys of published) {
                expect(keys).toHaveLength(2);
                expect(keys[0]).toBe("$a");
                expect(["~pending", "$real"]).toContain(keys[1]);
            }
            // The echo of our own message does not count as an unread one.
            expect(vm.getSnapshot().numUnreadMessages).toBe(0);
        });

        it("folds a burst of state changes into one publish", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const pending = addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("~pending"));
            const publishes = vi.fn();
            vm.subscribe(publishes);

            // Sending in an encrypted room walks the message through several states in quick
            // succession; the rows only need rebuilding once for all of them.
            room.updatePendingEvent(pending, EventStatus.ENCRYPTING);
            room.updatePendingEvent(pending, EventStatus.SENDING);
            expect(publishes).not.toHaveBeenCalled();
            await settle();

            expect(publishes).toHaveBeenCalledTimes(1);
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "~pending"]);
        });

        it("keeps the row's continuation decision when its id changes", async () => {
            const sentAt = new Date("2026-03-01T10:00:00Z").getTime();
            seedTimeline([makeMessage("$a", { ts: sentAt })]);
            const vm = await createStartedViewModel();
            // Sent straight after $a by the same person, so it is drawn as a continuation.
            const pending = addPendingMessage("~pending", { ts: sentAt + 1000 });
            await vi.waitFor(() => expect(eventRow(vm, "~pending")?.continuation).toBe(true));

            // The server stamps it well outside the continuation interval. Decided afresh, the row
            // would stop being a continuation and grow a header; the decision made for the local
            // id has to carry over instead.
            await receiveRemoteEcho(pending, "$real", sentAt + 10 * 60 * 1000);

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$real"]));
            expect(eventRow(vm, "$real")?.continuation).toBe(true);
        });

        it("never points the receipt or the saved position at a message still being sent", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("~pending"));

            // The reader can see everything, including the row still being sent.
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);

            await vi.waitFor(() => expect(client.sendReadReceipt).toHaveBeenCalled(), { timeout: 2000 });
            expect(vi.mocked(client.sendReadReceipt).mock.calls[0][0]?.getId()).toBe("$b");

            vm.onAtBottomStateChange(false);
            vm.dispose();
            expect(localStorage.getItem(`timeline_scroll_${ROOM_ID}`)).toBe("$b");
            expect(client.setRoomReadMarkers).toHaveBeenCalledWith(ROOM_ID, "$b");
        });

        it("moves the receipt and marker onto a message of ours once the server confirms it", async () => {
            seedTimeline([makeMessage("$a", { ts: 1000 })]);
            const vm = await createStartedViewModel();
            vm.onAnchorReached();
            const pending = addPendingMessage("~pending", { ts: 2000 });
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "~pending"]));
            // The reader can see both rows; the one still being sent is skipped.
            vm.onVisibleRangeChanged(0, vm.getSnapshot().items.length - 1);

            // The echo swaps the row's id without changing the number of rows, so the view has
            // nothing new to report: the view model has to notice on its own.
            await receiveRemoteEcho(pending, "$real", 2000);
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "$real"]));

            await vi.waitFor(
                () => expect(vi.mocked(client.sendReadReceipt).mock.calls.at(-1)?.[0]?.getId()).toBe("$real"),
                { timeout: 2000 },
            );
            vm.dispose();
            expect(client.setRoomReadMarkers).toHaveBeenCalledWith(ROOM_ID, "$real");
        });

        it("says how far a message being sent has got", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const pending = addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventRow(vm, "~pending")?.sendState).toBe("sending"));

            room.updatePendingEvent(pending, EventStatus.ENCRYPTING);
            await settle();
            expect(eventRow(vm, "~pending")?.sendState).toBe("encrypting");

            room.updatePendingEvent(pending, EventStatus.SENDING);
            await settle();
            expect(eventRow(vm, "~pending")?.sendState).toBe("sending");

            // The server has accepted it and given it an id, but /sync has not echoed it yet.
            room.updatePendingEvent(pending, EventStatus.SENT, "$real");
            await settle();
            expect(eventRow(vm, "$real")?.sendState).toBe("sent");
        });

        it("marks a delivered message as sending while our edit of it is", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();

            const edit = addPendingMessage("~edit", { relatesTo: { rel_type: RelationType.Replace, event_id: "$a" } });
            await vi.waitFor(() => expect(eventRow(vm, "$a")?.sendState).toBe("sending"));

            room.updatePendingEvent(edit, EventStatus.NOT_SENT);
            await settle();
            expect(eventRow(vm, "$a")?.sendState).toBe("failed");
        });

        it("keeps showing a message whose send failed, and drops one that is cancelled", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            const pending = addPendingMessage("~pending");
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("~pending"));

            // Failed: the row stays, so the reader can retry or cancel it.
            room.updatePendingEvent(pending, EventStatus.NOT_SENT);
            await settle();
            expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a", "~pending"]);
            expect(eventRow(vm, "~pending")?.sendState).toBe("failed");

            // Cancelled: the message leaves the pending list, so its row goes too.
            room.updatePendingEvent(pending, EventStatus.CANCELLED);
            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toEqual(["$a"]));
        });
    });

    describe("read receipts shown beside messages", () => {
        /** Record `userId` having read `eventId`, as a receipt arriving from sync would. */
        const receiveReceipt = (eventId: string, userId: string, ts: number): void => {
            room.addReceipt(
                new MatrixEvent({
                    type: EventType.Receipt,
                    content: { [eventId]: { [ReceiptType.Read]: { [userId]: { ts } } } },
                }),
            );
        };

        const usersOn = (vm: RoomTimelineViewModel, eventId: string): string[] | undefined =>
            vm
                .getSnapshot()
                .readReceiptsByEvent.get(eventId)
                ?.map((r) => r.userId);

        beforeEach(() => {
            vi.mocked(client.getSafeUserId).mockReturnValue(USER_ID);
        });

        it("draws another user's receipt beside the message they read", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();

            receiveReceipt("$a", OTHER_USER_ID, 1000);

            expect(usersOn(vm, "$a")).toEqual([OTHER_USER_ID]);
            expect(usersOn(vm, "$b")).toEqual([]);
        });

        it("leaves out the reader's own receipt", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();

            receiveReceipt("$a", USER_ID, 1000);

            expect(usersOn(vm, "$a")).toEqual([]);
        });

        it("draws a receipt for a hidden event beside the last shown message before it", async () => {
            // A reaction gets no row of its own; a receipt pointing at it belongs with the message above.
            const reaction = new MatrixEvent({
                type: EventType.Reaction,
                room_id: ROOM_ID,
                sender: OTHER_USER_ID,
                event_id: "$react",
                origin_server_ts: 3,
                content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$a", key: "👍" } },
            });
            seedTimeline([makeMessage("$a"), reaction, makeMessage("$b")]);
            const vm = await createStartedViewModel();

            receiveReceipt("$react", OTHER_USER_ID, 1000);

            expect(usersOn(vm, "$a")).toEqual([OTHER_USER_ID]);
        });

        it("orders a message's receipts newest first", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();

            receiveReceipt("$a", "@earlier:example.org", 1000);
            receiveReceipt("$a", "@later:example.org", 2000);

            expect(usersOn(vm, "$a")).toEqual(["@later:example.org", "@earlier:example.org"]);
        });

        it("keeps a user's receipt where it was when it moves onto a message that is not loaded", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            receiveReceipt("$b", OTHER_USER_ID, 1000);
            expect(usersOn(vm, "$b")).toEqual([OTHER_USER_ID]);

            receiveReceipt("$somewhere-else", OTHER_USER_ID, 2000);

            expect(usersOn(vm, "$b")).toEqual([OTHER_USER_ID]);
        });

        it("keeps the published receipts when a receipt changes nothing drawn", async () => {
            seedTimeline([makeMessage("$a"), makeMessage("$b")]);
            const vm = await createStartedViewModel();
            receiveReceipt("$a", OTHER_USER_ID, 1000);
            const published = vm.getSnapshot().readReceiptsByEvent;

            // Our own receipt is never drawn, so the rows have nothing to redraw.
            receiveReceipt("$b", USER_ID, 2000);
            expect(vm.getSnapshot().readReceiptsByEvent).toBe(published);

            // Someone else reading $b changes only $b's receipts; $a keeps its list.
            receiveReceipt("$b", "@carol:example.org", 3000);
            expect(vm.getSnapshot().readReceiptsByEvent).not.toBe(published);
            expect(vm.getSnapshot().readReceiptsByEvent.get("$a")).toBe(published.get("$a"));
        });

        it("picks up a reader's profile once their membership loads", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = await createStartedViewModel();
            receiveReceipt("$a", OTHER_USER_ID, 1000);
            expect(vm.getSnapshot().readReceiptsByEvent.get("$a")?.[0].roomMember).toBeNull();

            // Lazy-loaded members arrive after the room has opened.
            room.currentState.setStateEvents([
                mkMembership({
                    room: ROOM_ID,
                    mship: KnownMembership.Join,
                    user: OTHER_USER_ID,
                    name: "Bob",
                    event: true,
                }),
            ]);
            client.emit(RoomStateEvent.Update, room.currentState);

            expect(vm.getSnapshot().readReceiptsByEvent.get("$a")?.[0].roomMember?.name).toBe("Bob");
        });

        it("draws nothing while receipts are turned off, and everything once they are turned back on", async () => {
            seedTimeline([makeMessage("$a")]);
            const vm = new RoomTimelineViewModel({ client, room, showReadReceipts: false });
            vms.push(vm);
            vm.start();
            await vi.waitFor(() => expect(vm.getSnapshot().items.length).toBeGreaterThan(0));

            receiveReceipt("$a", OTHER_USER_ID, 1000);
            expect(vm.getSnapshot().readReceiptsByEvent.size).toBe(0);

            vm.setShowReadReceipts(true);
            expect(usersOn(vm, "$a")).toEqual([OTHER_USER_ID]);
        });
    });

    describe('the "Sent" tick', () => {
        beforeEach(() => {
            vi.mocked(client.getSafeUserId).mockReturnValue(USER_ID);
        });

        it("goes on the newest message of ours once it has reached the server", async () => {
            seedTimeline([makeMessage("$a", { user: OTHER_USER_ID }), makeMessage("$b", { user: USER_ID })]);

            const vm = await createStartedViewModel();

            expect(vm.getSnapshot().lastSuccessfulEventId).toBe("$b");
        });

        it("comes off our message once someone else's arrives below it", async () => {
            seedTimeline([makeMessage("$a", { user: USER_ID })]);
            const vm = await createStartedViewModel();
            expect(vm.getSnapshot().lastSuccessfulEventId).toBe("$a");

            const reply = makeMessage("$b", { user: OTHER_USER_ID });
            room.getUnfilteredTimelineSet().addLiveEvent(reply, { addToState: false });
            room.emit(RoomEvent.Timeline, reply, room, false, false, {
                timeline: room.getLiveTimeline(),
                liveEvent: true,
            } as any);

            await vi.waitFor(() => expect(eventKeys(vm.getSnapshot().items)).toContain("$b"));
            expect(vm.getSnapshot().lastSuccessfulEventId).toBeNull();
        });

        it("is not shown when someone else's message is newer than ours", async () => {
            seedTimeline([makeMessage("$a", { user: USER_ID }), makeMessage("$b", { user: OTHER_USER_ID })]);

            const vm = await createStartedViewModel();

            expect(vm.getSnapshot().lastSuccessfulEventId).toBeNull();
        });
    });
});
