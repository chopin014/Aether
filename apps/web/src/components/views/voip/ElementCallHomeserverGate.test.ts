/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ClientEvent,
    createClient,
    EventType,
    MatrixEvent,
    Room,
    SyncState,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { MatrixRTCSession, MembershipManagerEvent, Status } from "matrix-js-sdk/src/matrixrtc";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("@element-hq/element-call-component"), "utf8");
const start = source.indexOf("const aetherSyncOutageLimitMs");
const end = source.indexOf(
    "//#endregion",
    source.indexOf("//#region src/state/CallViewModel/localMember/HomeserverConnected.ts"),
);

type State = [boolean, string | null];
interface Gate {
    sync: (syncing: boolean) => void;
    membership: (connected: boolean) => void;
    probablyLeft: (value: boolean) => void;
    dispose: () => void;
}
interface GateOptions {
    syncing: boolean;
    membershipConnected: boolean;
    probablyLeft: boolean;
    outageLimitMs: number;
    firstJoinMs?: number;
}

/** A minimal Observable, standing in for the RxJS one Element Call bundles. */
class Observable<T> {
    public constructor(private readonly producer: (observer: { next: (value: T) => void }) => () => void) {}
    public subscribe(next: (value: T) => void): { unsubscribe: () => void } {
        return { unsubscribe: this.producer({ next }) };
    }
    public pipe<U>(operator: (source: Observable<T>) => Observable<U>): Observable<U> {
        return operator(this);
    }
}

/** A stand-in for Element Call's scope: a behavior keeps its latest value and the subscription that feeds it. */
class Scope {
    public readonly subscriptions: { unsubscribe: () => void }[] = [];
    public behavior<T>(observable: Observable<T>, initial?: T): { value: T; subscribe: Observable<T>["subscribe"] } {
        const listeners = new Set<(value: T) => void>();
        const behavior = {
            value: initial as T,
            subscribe: (next: (value: T) => void) => {
                listeners.add(next);
                next(behavior.value);
                return { unsubscribe: () => listeners.delete(next) };
            },
        };
        this.subscriptions.push(
            observable.subscribe((value) => {
                behavior.value = value;
                for (const listener of listeners) listener(value);
            }),
        );
        if (behavior.value === undefined) throw new Error("no initial value");
        return behavior;
    }
    public end(): void {
        for (const subscription of this.subscriptions) subscription.unsubscribe();
    }
}

/** Loads the shipped gate and homeserver state code of our Element Call patch, with stand-ins for its imports. */
function load(): {
    aetherSyncOutageLimitMs: number;
    aetherHomeserverGate: (
        options: GateOptions,
        publish: (state: State) => void,
        log: ((m: string) => void) | undefined,
        confirmMembership: () => Promise<boolean>,
    ) => Gate;
    b4: (
        scope: Scope,
        client: Pick<EventEmitter, "on" | "off">,
        session: Pick<EventEmitter, "on" | "off">,
        graceMs?: number,
        ownIdentity?: { userId: string; deviceId: string; memberId?: string },
    ) => {
        combined$: { value: State; subscribe: (next: (value: State) => void) => unknown };
        rtsSession$: { value: string };
    };
} {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fromEvent = <T>(target: EventEmitter, name: string): Observable<T> =>
        new Observable<T>(({ next }) => {
            target.on(name, next);
            return () => target.off(name, next);
        });
    const map =
        <T, U>(project: (value: T) => U) =>
        (input: Observable<T>): Observable<U> =>
            new Observable<U>(({ next }) => input.subscribe((value) => next(project(value))).unsubscribe);
    const logger = { getChild: () => ({ info: (): void => {} }) };
    const config = { get: () => ({ sync_disconnect_grace_period_ms: 1e4 }) };
    return new Function(
        "V",
        "ce",
        "Yk",
        "F",
        "C",
        "Bn",
        "Jn",
        "er",
        "tr",
        `${source.slice(start, end)}; return { aetherSyncOutageLimitMs, aetherHomeserverGate, b4 };`,
    )(logger, config, fromEvent, map, Observable, ClientEvent, SyncState, MembershipManagerEvent, Status);
}

describe("Element Call homeserver gate", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /** Membership checks that the test answers one at a time. */
    const checks = (): {
        confirm: () => Promise<boolean>;
        pending: number;
        answer: (present: boolean) => Promise<void>;
    } => {
        const waiting: ((present: boolean) => void)[] = [];
        return {
            confirm: () => new Promise<boolean>((resolve) => waiting.push(resolve)),
            get pending() {
                return waiting.length;
            },
            answer: async (present) => {
                // A check starts a moment after the sync response that asks for it.
                await vi.advanceTimersByTimeAsync(0);
                waiting.shift()!(present);
                await vi.advanceTimersByTimeAsync(0);
            },
        };
    };

    const gate = (
        options: Partial<GateOptions> = {},
        confirm: () => Promise<boolean> = async () => true,
    ): { gate: Gate; published: State[]; limit: number } => {
        const { aetherHomeserverGate, aetherSyncOutageLimitMs } = load();
        const published: State[] = [];
        const created = aetherHomeserverGate(
            {
                syncing: true,
                membershipConnected: true,
                probablyLeft: false,
                outageLimitMs: aetherSyncOutageLimitMs,
                ...options,
            },
            (state) => published.push(state),
            undefined,
            confirm,
        );
        return { gate: created, published, limit: aetherSyncOutageLimitMs };
    };

    it("keeps the call connected through a sync outage shorter than the limit", () => {
        const { gate: g, published, limit } = gate();
        g.sync(false);
        vi.advanceTimersByTime(limit - 1);
        g.sync(true);
        vi.advanceTimersByTime(limit);
        expect(published).toEqual([[true, null]]);
    });

    it("counts a sync outage as lost once it lasts the limit, and recovers with sync", () => {
        const { gate: g, published, limit } = gate();
        g.sync(false);
        // Each failed sync attempt reports again; that must not restart the outage.
        vi.advanceTimersByTime(limit / 2);
        g.sync(false);
        vi.advanceTimersByTime(limit / 2);
        expect(published).toEqual([
            [true, null],
            [false, "sync"],
        ]);
        g.sync(true);
        expect(published.at(-1)).toEqual([true, null]);
    });

    it("reports a lost membership at once, with or without sync", () => {
        const { gate: g, published } = gate();
        g.membership(false);
        expect(published.at(-1)).toEqual([false, "membership"]);
        g.membership(true);
        g.sync(false);
        g.membership(false);
        expect(published).toEqual([
            [true, null],
            [false, "membership"],
            [true, null],
            [false, "membership"],
        ]);
    });

    it("waits for its own membership after a possible leave", async () => {
        const check = checks();
        const { gate: g, published } = gate({}, check.confirm);
        g.sync(false);
        g.probablyLeft(true);
        // The manager made a new delayed leave, but only the memberships show whether the old one was sent.
        g.probablyLeft(false);
        g.sync(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(check.pending).toBe(1);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
        await check.answer(true);
        expect(published).toEqual([
            [true, null],
            [false, "probablyLeft"],
            [true, null],
        ]);
    });

    it("stays paused while its membership is missing, until a later sync shows it again", async () => {
        const check = checks();
        const { gate: g, published } = gate({}, check.confirm);
        g.probablyLeft(true);
        g.probablyLeft(false);
        g.sync(true);
        await check.answer(false);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
        g.sync(true);
        await check.answer(true);
        expect(published.at(-1)).toEqual([true, null]);
    });

    it("checks nothing while the manager still reports a probable leave", async () => {
        const check = checks();
        const { gate: g, published } = gate({}, check.confirm);
        g.probablyLeft(true);
        g.sync(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(check.pending).toBe(0);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
    });

    it("ignores a check from before another possible leave", async () => {
        const check = checks();
        const { gate: g, published } = gate({}, check.confirm);
        g.probablyLeft(true);
        g.probablyLeft(false);
        g.sync(true);
        g.probablyLeft(true);
        g.probablyLeft(false);
        await check.answer(true);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
        g.sync(true);
        await check.answer(true);
        expect(published.at(-1)).toEqual([true, null]);
    });

    it("runs one check at a time, and checks the latest state again after a failed one", async () => {
        let calls = 0;
        const { gate: g, published } = gate({}, async () => {
            calls++;
            if (calls === 1) throw new Error("recalculation failed");
            return true;
        });
        g.probablyLeft(true);
        g.probablyLeft(false);
        g.sync(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toBe(1);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
        g.sync(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toBe(2);
        expect(published.at(-1)).toEqual([true, null]);
    });

    it("ignores an answer made out of date by a newer sync response, and checks that one", async () => {
        const check = checks();
        const { gate: g, published } = gate({}, check.confirm);
        g.probablyLeft(true);
        g.probablyLeft(false);
        g.sync(true);
        await vi.advanceTimersByTimeAsync(0);
        // A newer response arrives during the check, which may have removed the membership.
        g.sync(true);
        expect(check.pending).toBe(1);
        await check.answer(true);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
        expect(check.pending).toBe(1);
        await check.answer(false);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
        expect(check.pending).toBe(0);
    });

    it("resumes from the latest check when a newer sync response brought the membership back", async () => {
        const check = checks();
        const { gate: g, published } = gate({}, check.confirm);
        g.probablyLeft(true);
        g.probablyLeft(false);
        g.sync(true);
        await vi.advanceTimersByTimeAsync(0);
        g.sync(true);
        await check.answer(false);
        await check.answer(true);
        expect(published.at(-1)).toEqual([true, null]);
    });

    it("starts from the state it is given", () => {
        expect(gate({ membershipConnected: false, firstJoinMs: 0 }).published).toEqual([[false, "membership"]]);
        expect(gate({ probablyLeft: true }).published).toEqual([[false, "probablyLeft"]]);
        const { published, limit } = gate({ syncing: false });
        vi.advanceTimersByTime(limit);
        expect(published).toEqual([
            [true, null],
            [false, "sync"],
        ]);
        expect(gate({ syncing: false, outageLimitMs: 0 }).published).toEqual([[false, "sync"]]);
    });

    it("lets a join's media out while its first membership write is on its way, for a bounded time", () => {
        const { gate: g, published } = gate({ membershipConnected: false, firstJoinMs: 5000 });
        expect(published).toEqual([[true, null]]);
        vi.advanceTimersByTime(4999);
        expect(published).toEqual([[true, null]]);
        // A write that has not returned by then holds the media back, as any missing membership does.
        vi.advanceTimersByTime(1);
        expect(published).toEqual([
            [true, null],
            [false, "membership"],
        ]);
        g.membership(true);
        expect(published.at(-1)).toEqual([true, null]);
    });

    it("holds media back when a membership is lost after the first write returned", () => {
        const { gate: g, published } = gate({ membershipConnected: false, firstJoinMs: 5000 });
        g.membership(true);
        g.membership(false);
        expect(published).toEqual([
            [true, null],
            [false, "membership"],
        ]);
        // The first join's allowance is spent: no later timer lets media out again.
        vi.advanceTimersByTime(10_000);
        expect(published.at(-1)).toEqual([false, "membership"]);
    });

    it("still reports a sync outage or a probable leave during the first write", () => {
        const { gate: g, published } = gate({ membershipConnected: false, firstJoinMs: 5000 });
        g.probablyLeft(true);
        expect(published.at(-1)).toEqual([false, "probablyLeft"]);
    });

    it("reports nothing after it is disposed", async () => {
        const check = checks();
        const { gate: g, published, limit } = gate({}, check.confirm);
        g.probablyLeft(true);
        g.probablyLeft(false);
        g.sync(true);
        g.sync(false);
        g.dispose();
        vi.advanceTimersByTime(limit);
        await check.answer(true);
        expect(published).toEqual([
            [true, null],
            [false, "probablyLeft"],
        ]);
    });

    it("is given the identity the call joins with", () => {
        // The call view model builds `E` as its own membership identity, the one it joins the session with.
        const builder = source.indexOf("memberId: S === x.Matrix_2_0 ? H2() : `${d}:${f}`");
        expect(source.slice(builder - 200, builder)).toContain("E = {");
        expect(source.indexOf("homeserverConnected: b4(e, u, t, void 0, E)", builder)).toBeGreaterThan(builder);
    });

    describe("as wired into the call, with the real SDK session", () => {
        const roomId = "!call:example.org";
        const userId = "@alice:example.org";
        const deviceId = "ALICEDEVICE";
        const stateKey = `_${userId}_${deviceId}_m.call`;
        let eventCount = 0;

        const stateEvent = (type: string, key: string, content: object): MatrixEvent =>
            new MatrixEvent({
                type,
                state_key: key,
                sender: userId,
                room_id: roomId,
                event_id: `$event${++eventCount}`,
                origin_server_ts: Date.now(),
                content,
            });
        /** A call membership state event of the user's device; empty content is a sent leave. */
        const membership = (joined: boolean, device = deviceId, participation?: string): MatrixEvent =>
            stateEvent(
                EventType.GroupCallMemberPrefix,
                (device === deviceId ? stateKey : `_${userId}_${device}_m.call`) + (participation ?? ""),
                joined
                    ? {
                          application: "m.call",
                          call_id: "",
                          scope: "m.room",
                          device_id: device,
                          ...(participation ? { membershipID: participation } : {}),
                          expires: 4 * 60 * 60 * 1000,
                          focus_active: { type: "livekit", focus_selection: "oldest_membership" },
                          foci_preferred: [{ type: "livekit", livekit_service_url: "https://jwt.example.org" }],
                      }
                    : {},
            );

        const setup = async (): Promise<{
            scope: Scope;
            client: MatrixClient;
            room: Room;
            session: MatrixRTCSession;
            manager: { status: Status; probablyLeft: boolean };
            emitted: State[];
            state: { value: State };
            limit: number;
            listeners: () => unknown[];
            baseListeners: unknown[];
        }> => {
            const { b4, aetherSyncOutageLimitMs } = load();
            const client = createClient({ baseUrl: "https://example.org", userId, deviceId, accessToken: "token" });
            vi.spyOn(client, "getSyncState").mockReturnValue(SyncState.Syncing);
            const room = new Room(roomId, client, userId);
            room.currentState.setStateEvents([
                stateEvent(EventType.RoomCreate, "", {}),
                stateEvent(EventType.RoomMember, userId, { membership: "join" }),
                membership(true),
                // The same user, in the call from another device too.
                membership(true, "OTHERDEVICE"),
            ]);
            const session = MatrixRTCSession.sessionForSlot(client, room, { application: "m.call", id: "ROOM" });
            await session.ensureRecalculateSessionMembers();
            expect(session.memberships.map((m) => m.deviceId).sort()).toEqual([deviceId, "OTHERDEVICE"]);
            // The membership manager only exists once the call is joined; these stand in for its state.
            const manager = { status: Status.Connected, probablyLeft: false };
            Object.defineProperty(session, "membershipStatus", { get: () => manager.status });
            Object.defineProperty(session, "probablyLeft", { get: () => manager.probablyLeft });
            const listeners = (): unknown[] => [
                ...client.listeners(ClientEvent.Sync),
                ...session.listeners(MembershipManagerEvent.ProbablyLeft),
                ...session.listeners(MembershipManagerEvent.StatusChanged),
            ];
            const baseListeners = listeners();
            const scope = new Scope();
            // The identity Element Call joins with outside Matrix 2.0.
            const { combined$ } = b4(scope, client, session, undefined, {
                userId,
                deviceId,
                memberId: `${userId}:${deviceId}`,
            });
            const emitted: State[] = [];
            combined$.subscribe((value) => emitted.push(value));
            return {
                scope,
                client,
                room,
                session,
                manager,
                emitted,
                state: combined$,
                limit: aetherSyncOutageLimitMs,
                listeners,
                baseListeners,
            };
        };

        it("follows sync and membership status", async () => {
            const { client, session, manager, state, limit } = await setup();
            expect(state.value).toEqual([true, null]);
            client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing);
            vi.advanceTimersByTime(limit - 1);
            expect(state.value).toEqual([true, null]);
            vi.advanceTimersByTime(1);
            expect(state.value).toEqual([false, "sync"]);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Reconnecting);
            expect(state.value).toEqual([true, null]);

            manager.status = Status.Connecting;
            session.emit(MembershipManagerEvent.StatusChanged, Status.Connected, Status.Connecting);
            expect(state.value).toEqual([false, "membership"]);
            await session.stop();
        });

        it("does not resume after a sent delayed leave until its membership is back", async () => {
            const { client, room, session, manager, emitted, state } = await setup();
            const settle = async (): Promise<void> => {
                await vi.advanceTimersByTimeAsync(0);
                await session.ensureRecalculateSessionMembers();
                await vi.advanceTimersByTimeAsync(0);
            };
            // The outage outlasts the delayed leave: the manager reports a probable leave and the server sends it.
            manager.probablyLeft = true;
            session.emit(MembershipManagerEvent.ProbablyLeft, true);
            const pausedAt = emitted.length;
            room.currentState.setStateEvents([membership(false)]);
            // The connection returns. The manager makes a new delayed leave and reports itself connected again before
            // it learns that the membership is gone (the order the SDK can take).
            manager.probablyLeft = false;
            session.emit(MembershipManagerEvent.ProbablyLeft, false);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
            await settle();
            expect(session.memberships.map((m) => m.deviceId)).toEqual(["OTHERDEVICE"]);
            expect(state.value).toEqual([false, "probablyLeft"]);

            // The manager joins again; until its membership arrives through sync, the call stays paused.
            manager.status = Status.Connecting;
            session.emit(MembershipManagerEvent.StatusChanged, Status.Connected, Status.Connecting);
            manager.status = Status.Connected;
            session.emit(MembershipManagerEvent.StatusChanged, Status.Connecting, Status.Connected);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
            await settle();
            expect(emitted.slice(pausedAt).some(([connected]) => connected)).toBe(false);

            room.currentState.setStateEvents([membership(true)]);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
            await settle();
            expect(state.value).toEqual([true, null]);
            await session.stop();
        });

        it("resumes after a possible leave that the server never sent", async () => {
            const { client, session, manager, state } = await setup();
            manager.probablyLeft = true;
            session.emit(MembershipManagerEvent.ProbablyLeft, true);
            manager.probablyLeft = false;
            session.emit(MembershipManagerEvent.ProbablyLeft, false);
            expect(state.value).toEqual([false, "probablyLeft"]);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
            await vi.advanceTimersByTimeAsync(0);
            await session.ensureRecalculateSessionMembers();
            await vi.advanceTimersByTimeAsync(0);
            expect(state.value).toEqual([true, null]);
            await session.stop();
        });

        /** Holds the next membership calculation's answer until `release` is called. */
        const holdNextCalculation = (): { release: () => Promise<void> } => {
            const original = MatrixRTCSession.sessionMembershipsForSlot.bind(MatrixRTCSession);
            let release!: () => void;
            const released = new Promise<void>((resolve) => (release = resolve));
            vi.spyOn(MatrixRTCSession, "sessionMembershipsForSlot").mockImplementationOnce(async (...args) => {
                // It reads the room as it is now, and answers later.
                const result = original(...args);
                await released;
                return result;
            });
            return {
                release: async () => {
                    release();
                    await vi.advanceTimersByTimeAsync(0);
                },
            };
        };

        it("does not resume on a check that a newer sync response overtook", async () => {
            const { client, room, session, manager, emitted, state } = await setup();
            manager.probablyLeft = true;
            session.emit(MembershipManagerEvent.ProbablyLeft, true);
            manager.probablyLeft = false;
            session.emit(MembershipManagerEvent.ProbablyLeft, false);
            const pausedAt = emitted.length;
            // Response A still has the membership; its check is slow.
            const held = holdNextCalculation();
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
            await vi.advanceTimersByTimeAsync(0);
            // Response B brings the sent leave.
            room.currentState.setStateEvents([membership(false)]);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
            await held.release();
            await session.ensureRecalculateSessionMembers();
            await vi.advanceTimersByTimeAsync(0);
            expect(session.memberships.map((m) => m.deviceId)).toEqual(["OTHERDEVICE"]);
            expect(emitted.slice(pausedAt).some(([connected]) => connected)).toBe(false);
            expect(state.value).toEqual([false, "probablyLeft"]);
            await session.stop();
        });

        it("does not count an older participation of the same device", async () => {
            const { client, room, session, manager, state } = await setup();
            // An earlier participation of this device that was never cleaned up, and the current one's sent leave.
            room.currentState.setStateEvents([membership(true, deviceId, "older-participation")]);
            manager.probablyLeft = true;
            session.emit(MembershipManagerEvent.ProbablyLeft, true);
            room.currentState.setStateEvents([membership(false)]);
            manager.probablyLeft = false;
            session.emit(MembershipManagerEvent.ProbablyLeft, false);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
            await vi.advanceTimersByTimeAsync(0);
            await session.ensureRecalculateSessionMembers();
            await vi.advanceTimersByTimeAsync(0);
            expect(session.memberships.map((m) => m.memberId)).toContain("older-participation");
            expect(state.value).toEqual([false, "probablyLeft"]);
            await session.stop();
        });

        describe("with Matrix 2.0 sticky memberships", () => {
            const current = "current-participation";
            /** A sticky membership event of this device for a participation; a leave is a newer one with its key. */
            const sticky = (participation: string, joined: boolean): MatrixEvent => {
                // Each event is a moment newer, so the latest one for a key wins.
                vi.advanceTimersByTime(1000);
                return new MatrixEvent({
                    type: EventType.RTCMembership,
                    sender: userId,
                    room_id: roomId,
                    event_id: `$sticky${++eventCount}`,
                    origin_server_ts: Date.now(),
                    msc4354_sticky: { duration_ms: 60 * 60 * 1000 },
                    content: joined
                        ? {
                              application: { type: "m.call" },
                              slot_id: "m.call#ROOM",
                              transports: { published: [{ type: "livekit" }], can_subscribe: ["livekit"] },
                              member: { device_id: deviceId, user_id: userId, id: participation, membership: "join" },
                              msc4354_sticky_key: participation,
                          }
                        : {
                              slot_id: "m.call#ROOM",
                              member: { id: participation, membership: "leave" },
                              msc4354_sticky_key: participation,
                          },
                } as ConstructorParameters<typeof MatrixEvent>[0]);
            };

            const setupSticky = async (
                participations: string[],
            ): Promise<{
                client: MatrixClient;
                room: Room;
                session: MatrixRTCSession;
                manager: { status: Status; probablyLeft: boolean };
                emitted: State[];
                state: { value: State };
                settleAfterSync: () => Promise<void>;
            }> => {
                const { b4 } = load();
                const client = createClient({ baseUrl: "https://example.org", userId, deviceId, accessToken: "token" });
                vi.spyOn(client, "getSyncState").mockReturnValue(SyncState.Syncing);
                const room = new Room(roomId, client, userId);
                room.currentState.setStateEvents([
                    stateEvent(EventType.RoomCreate, "", {}),
                    stateEvent(EventType.RoomMember, userId, { membership: "join" }),
                ]);
                room._unstable_addStickyEvents(participations.map((participation) => sticky(participation, true)));
                const session = MatrixRTCSession.sessionForSlot(client, room, { application: "m.call", id: "ROOM" });
                await session.ensureRecalculateSessionMembers();
                expect(session.memberships.map((m) => m.memberId).sort()).toEqual([...participations].sort());
                const manager = { status: Status.Connected, probablyLeft: false };
                Object.defineProperty(session, "membershipStatus", { get: () => manager.status });
                Object.defineProperty(session, "probablyLeft", { get: () => manager.probablyLeft });
                // Element Call's Matrix 2.0 identity: a member id for this participation.
                const { combined$ } = b4(new Scope(), client, session, undefined, {
                    userId,
                    deviceId,
                    memberId: current,
                });
                const emitted: State[] = [];
                combined$.subscribe((value) => emitted.push(value));
                const settleAfterSync = async (): Promise<void> => {
                    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
                    await vi.advanceTimersByTimeAsync(0);
                    await session.ensureRecalculateSessionMembers();
                    await vi.advanceTimersByTimeAsync(0);
                };
                return { client, room, session, manager, emitted, state: combined$, settleAfterSync };
            };
            const possibleLeave = (
                session: MatrixRTCSession,
                manager: { probablyLeft: boolean },
                whileLeft?: () => void,
            ): void => {
                manager.probablyLeft = true;
                session.emit(MembershipManagerEvent.ProbablyLeft, true);
                whileLeft?.();
                manager.probablyLeft = false;
                session.emit(MembershipManagerEvent.ProbablyLeft, false);
            };

            it("stays paused after a sent leave of its participation, until it joins again", async () => {
                const { room, session, manager, emitted, state, settleAfterSync } = await setupSticky([current]);
                const pausedAt = emitted.length;
                possibleLeave(session, manager, () => room._unstable_addStickyEvents([sticky(current, false)]));
                await settleAfterSync();
                expect(session.memberships).toEqual([]);
                expect(state.value).toEqual([false, "probablyLeft"]);
                room._unstable_addStickyEvents([sticky(current, true)]);
                await settleAfterSync();
                expect(emitted.slice(pausedAt, -1).some(([connected]) => connected)).toBe(false);
                expect(state.value).toEqual([true, null]);
                await session.stop();
            });

            it("does not count an older participation that outlived the current one", async () => {
                const { room, session, manager, state, settleAfterSync } = await setupSticky([
                    "older-participation",
                    current,
                ]);
                possibleLeave(session, manager, () => room._unstable_addStickyEvents([sticky(current, false)]));
                await settleAfterSync();
                expect(session.memberships.map((m) => m.memberId)).toEqual(["older-participation"]);
                expect(state.value).toEqual([false, "probablyLeft"]);
                await session.stop();
            });

            it("resumes when only another participation left", async () => {
                const { room, session, manager, state, settleAfterSync } = await setupSticky([
                    "older-participation",
                    current,
                ]);
                possibleLeave(session, manager, () =>
                    room._unstable_addStickyEvents([sticky("older-participation", false)]),
                );
                await settleAfterSync();
                expect(session.memberships.map((m) => m.memberId)).toEqual([current]);
                expect(state.value).toEqual([true, null]);
                await session.stop();
            });
        });

        it("stops listening when the call ends", async () => {
            const { scope, client, session, listeners, baseListeners } = await setup();
            const added = listeners().filter((listener) => !baseListeners.includes(listener));
            expect(added).toHaveLength(3);
            // An outage in progress has a timer running, which must stop too.
            client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing);
            const timers = vi.getTimerCount();
            scope.end();
            expect(listeners().filter((listener) => added.includes(listener))).toEqual([]);
            expect(vi.getTimerCount()).toBe(timers - 1);
            await session.stop();
        });
    });
});
