/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

interface TestObservable<T> {
    subscribe(next: (value: T) => void): { unsubscribe(): void };
}

interface TestBehavior<T> extends TestObservable<T> {
    value: T;
    next(value: T): void;
}

interface TestMember {
    userId: string;
    participant: {
        type: "local" | "remote";
        value$: TestBehavior<object | null>;
    };
}

const require = createRequire(import.meta.url);
const componentPath = require.resolve("@element-hq/element-call-component");
const componentRequire = createRequire(componentPath);
const rxjs = componentRequire("rxjs") as Record<string, unknown> & {
    BehaviorSubject: new <T>(value: T) => TestBehavior<T>;
    map: <T, R>(project: (value: T) => R) => unknown;
};
const source = readFileSync(componentPath, "utf8");

function createMember(userId: string, type: "local" | "remote", connected: boolean): TestMember {
    return { userId, participant: { type, value$: new rxjs.BehaviorSubject<object | null>(connected ? {} : null) } };
}

function observeMembers(local: TestMember | null, remote: TestMember[]) {
    const helperStart = source.indexOf("function aetherObserveVisibleCallMembers(");
    const helperEnd = source.indexOf("\nfunction G4(", helperStart);
    const pipelineStart = source.indexOf("te = e.behavior(Lk([ee, k]") + "te = ".length;
    const pipelineEnd = source.indexOf(", ne = i3(", pipelineStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(pipelineEnd).toBeGreaterThan(pipelineStart);

    const local$ = new rxjs.BehaviorSubject(local);
    const remote$ = new rxjs.BehaviorSubject({ value: remote });
    // Execute the installed component's pipeline to cover its compiled RxJS aliases and wiring.
    const run = new Function(
        "e",
        "ee",
        "k",
        "Lk",
        "wA",
        "F",
        "Ck",
        "$e",
        source.slice(helperStart, helperEnd) + "\nreturn " + source.slice(pipelineStart, pipelineEnd) + ";",
    );
    const visible$ = run(
        { behavior: (observable: unknown) => observable },
        local$,
        remote$,
        rxjs.combineLatest,
        rxjs.switchMap,
        rxjs.map,
        rxjs.of,
        rxjs.distinctUntilChanged,
    ) as TestObservable<TestMember[]>;
    const updated = vi.fn();
    const subscription = visible$.subscribe(updated);
    return { local$, remote$, updated, subscription };
}

describe("embedded Element Call participants", () => {
    it("should hide an old device's waiting tile when the local user joins", () => {
        const local = createMember("@alice:example.org", "local", true);
        const stale = createMember(local.userId, "remote", false);
        const remote = createMember("@bob:example.org", "remote", true);
        const call = observeMembers(null, [stale, remote]);

        expect(call.updated).toHaveBeenLastCalledWith([stale, remote]);
        call.local$.next(local);
        expect(call.updated).toHaveBeenLastCalledWith([local, remote]);
        call.local$.next(null);
        expect(call.updated).toHaveBeenLastCalledWith([stale, remote]);
        call.subscription.unsubscribe();
    });

    it("should hide a remote user's stale device on both sides of the call", () => {
        const local = createMember("@bob:example.org", "local", true);
        const stale = createMember("@alice:example.org", "remote", false);
        const active = createMember(stale.userId, "remote", true);
        const call = observeMembers(local, [stale, active]);

        expect(call.updated).toHaveBeenLastCalledWith([local, active]);
        call.subscription.unsubscribe();
    });

    it("should keep the local tile while its media connection is starting", () => {
        const local = createMember("@alice:example.org", "local", false);
        const stale = createMember(local.userId, "remote", false);
        const call = observeMembers(local, [stale]);

        expect(call.updated).toHaveBeenLastCalledWith([local]);
        call.subscription.unsubscribe();
    });

    it("should preserve a participant's only tile while waiting for media", () => {
        const waiting = createMember("@alice:example.org", "remote", false);
        const call = observeMembers(null, [waiting]);

        expect(call.updated).toHaveBeenLastCalledWith([waiting]);
        call.subscription.unsubscribe();
    });

    it("should keep two genuinely connected devices belonging to the same user", () => {
        const local = createMember("@alice:example.org", "local", true);
        const otherDevice = createMember(local.userId, "remote", true);
        const call = observeMembers(local, [otherDevice]);

        expect(call.updated).toHaveBeenLastCalledWith([local, otherDevice]);
        call.subscription.unsubscribe();
    });

    it("should update waiting tiles as devices connect, disconnect and leave", () => {
        const stale = createMember("@alice:example.org", "remote", false);
        const active = createMember(stale.userId, "remote", false);
        const call = observeMembers(null, [stale, active]);

        active.participant.value$.next({});
        expect(call.updated).toHaveBeenLastCalledWith([active]);
        stale.participant.value$.next({});
        expect(call.updated).toHaveBeenLastCalledWith([stale, active]);
        active.participant.value$.next(null);
        expect(call.updated).toHaveBeenLastCalledWith([stale]);
        stale.participant.value$.next(null);
        expect(call.updated).toHaveBeenLastCalledWith([stale, active]);
        call.remote$.next({ value: [active] });
        expect(call.updated).toHaveBeenLastCalledWith([active]);
        call.remote$.next({ value: [] });
        expect(call.updated).toHaveBeenLastCalledWith([]);
        call.subscription.unsubscribe();
    });

    it("should stop observing devices after their memberships leave", () => {
        const member = createMember("@alice:example.org", "remote", false);
        const call = observeMembers(null, [member]);
        call.remote$.next({ value: [] });
        call.updated.mockClear();

        member.participant.value$.next({});
        expect(call.updated).not.toHaveBeenCalled();
        call.subscription.unsubscribe();
    });

    it("should avoid reemitting the same visible members when media changes", () => {
        const member = createMember("@alice:example.org", "remote", true);
        const call = observeMembers(null, [member]);
        call.updated.mockClear();

        member.participant.value$.next({});
        expect(call.updated).not.toHaveBeenCalled();
        call.subscription.unsubscribe();
    });
});

describe("embedded Element Call screen shares", () => {
    const events = {
        TrackPublished: "trackPublished",
        TrackUnpublished: "trackUnpublished",
        LocalTrackPublished: "localTrackPublished",
        LocalTrackUnpublished: "localTrackUnpublished",
        TrackMuted: "trackMuted",
        TrackUnmuted: "trackUnmuted",
    };

    function observeScreenShares(muted: boolean, type: "local" | "remote" = "remote") {
        let publication: { isMuted: boolean } | undefined = { isMuted: muted };
        const participant = Object.assign(new EventEmitter(), {
            // LiveKit keeps this true for a muted screen track that is still published.
            isScreenShareEnabled: true,
            getTrackPublication: () => publication,
        });
        const participant$ = new rxjs.BehaviorSubject(participant);
        const start = source.indexOf("s = e.behavior(o.pipe", source.indexOf("function T3(")) + "s = ".length;
        const end = source.indexOf(", c = e.behavior", start);
        const observeStart = source.indexOf("function iL(");
        const observeEnd = source.indexOf("\nfunction aL(", observeStart);
        expect(end).toBeGreaterThan(start);
        // Run the installed screen-share pipeline and event observer, substituting only child view models.
        const run = new Function(
            "e",
            "o",
            "i",
            "t",
            "C",
            "CA",
            "J",
            "ML",
            "Ck",
            "wA",
            "F",
            "Z",
            "C3",
            "w3",
            source.slice(observeStart, observeEnd) + "\nreturn " + source.slice(start, end) + ";",
        );
        const create = (): string => "screen-share";
        const shares$ = run(
            { behavior: (observable: unknown) => observable },
            participant$,
            { id: "test-user" },
            { type, value$: participant$ },
            rxjs.Observable,
            rxjs.startWith,
            events,
            (_name: string, items: (value: unknown) => Iterable<unknown>) => rxjs.map(items),
            rxjs.of,
            rxjs.switchMap,
            rxjs.map,
            { Source: { ScreenShare: "screen_share" } },
            create,
            create,
        ) as TestObservable<Iterable<unknown>>;
        const updated = vi.fn();
        const subscription = shares$.subscribe((items) => updated(Array.from(items)));
        return {
            participant,
            updated,
            subscription,
            setMuted: (isMuted: boolean): void => {
                publication!.isMuted = isMuted;
                participant.emit(isMuted ? events.TrackMuted : events.TrackUnmuted);
            },
            unpublish: (): void => {
                publication = undefined;
                participant.isScreenShareEnabled = false;
                participant.emit(type === "local" ? events.LocalTrackUnpublished : events.TrackUnpublished);
            },
        };
    }

    it.each(["local", "remote"] as const)("should hide an already muted %s screen share", (type) => {
        const call = observeScreenShares(true, type);
        expect(call.updated).toHaveBeenLastCalledWith([]);
        call.subscription.unsubscribe();
    });

    it("should remove a blank panel when a published share is muted and restore it when resumed", () => {
        const call = observeScreenShares(false);
        expect(call.updated.mock.lastCall![0]).toHaveLength(1);
        call.setMuted(true);
        expect(call.updated).toHaveBeenLastCalledWith([]);
        call.setMuted(false);
        expect(call.updated.mock.lastCall![0]).toHaveLength(1);
        call.unpublish();
        expect(call.updated).toHaveBeenLastCalledWith([]);
        call.subscription.unsubscribe();
        expect(call.participant.eventNames()).toEqual([]);
    });
});
