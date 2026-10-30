/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import EventEmitter from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import type { SoundboardTransport } from "./SoundboardTransport";

const require = createRequire(import.meta.url);
const componentPath = require.resolve("@element-hq/element-call-component");
const { BehaviorSubject, Subject, Observable, combineLatest, switchMap, takeUntil } = createRequire(componentPath)(
    "rxjs",
) as {
    BehaviorSubject: new <T>(value: T) => { value: T; next(value: T): void };
    Subject: new <T>() => { next(value?: T): void };
    Observable: unknown;
    combineLatest: unknown;
    switchMap: unknown;
    takeUntil: (notifier: unknown) => unknown;
};
const source = readFileSync(componentPath, "utf8");
const start = source.indexOf("function aetherCreateSoundboardTransport(");
const end = source.indexOf("function aetherObserveDeafened(", start);

function fixture(encrypted = false) {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const local = Object.assign(new EventEmitter(), { publishData: vi.fn().mockResolvedValue(undefined) });
    const remote = new EventEmitter();
    const participant$ = new BehaviorSubject<EventEmitter | null>(remote);
    const media$ = new BehaviorSubject([
        {
            local: true,
            userId: "@alice:example.org",
            microphoneParticipant$: new BehaviorSubject<EventEmitter | null>(local),
        },
        { local: false, userId: "@bob:example.org", microphoneParticipant$: participant$ },
    ]);
    const disposed$ = new Subject<void>();
    const room = { isE2EEEnabled: encrypted, engine: { e2eeManager: { isDataChannelEncryptionEnabled: encrypted } } };
    const scope = { bind: () => takeUntil(disposed$) };
    const membership = {
        connection$: new BehaviorSubject({ livekitRoom: room }),
        connected$: new BehaviorSubject(true),
        participant$: new BehaviorSubject(local),
    };
    // Execute the installed adapter with actual RxJS subscriptions, including participant rebinding and teardown.
    const factory = new Function(
        "C",
        "Lk",
        "wA",
        "J",
        "Pu",
        `${source.slice(start, end)}; return aetherCreateSoundboardTransport;`,
    )(Observable, combineLatest, switchMap, { DataReceived: "dataReceived" }, { GCM: 1 }) as (
        scope: unknown,
        membership: unknown,
        media: unknown,
    ) => SoundboardTransport;
    return {
        transport: factory(scope, membership, media$),
        local,
        remote,
        participant$,
        media$,
        disposed$,
        room,
        membership,
    };
}

describe("soundboard call data adapter", () => {
    it("publishes reliable playback data and refuses disconnected or unencrypted sends in encrypted calls", async () => {
        const f = fixture(true);
        const payload = new Uint8Array([1, 2]);
        await f.transport.send(payload);
        expect(f.local.publishData).toHaveBeenCalledWith(payload, { reliable: true, topic: "io.aether.soundboard" });
        f.room.engine.e2eeManager.isDataChannelEncryptionEnabled = false;
        expect(() => f.transport.send(payload)).toThrow("encryption");
        f.membership.connected$.next(false);
        expect(() => f.transport.send(payload)).toThrow("not connected");
        expect(f.local.publishData).toHaveBeenCalledOnce();
    });

    it("maps payloads to the validated Matrix participant and filters local, oversized and plaintext packets", () => {
        const f = fixture(true);
        const listener = vi.fn();
        const unsubscribe = f.transport.subscribe(listener);
        const payload = new Uint8Array([1, 2]);
        f.remote.emit("dataReceived", payload, 0, 0);
        f.remote.emit("dataReceived", new Uint8Array(8193), 0, 1);
        f.local.emit("dataReceived", payload, 0, 1);
        expect(listener).not.toHaveBeenCalled();
        f.remote.emit("dataReceived", payload, 0, 1);
        expect(listener).toHaveBeenCalledExactlyOnceWith(payload, "@bob:example.org");
        unsubscribe();
        expect(f.remote.listenerCount("dataReceived")).toBe(0);
    });

    it("rebinds after participant replacement and releases listeners on media changes and scope disposal", () => {
        const f = fixture();
        const listener = vi.fn();
        f.transport.subscribe(listener);
        const replacement = new EventEmitter();
        f.participant$.next(replacement);
        expect(f.remote.listenerCount("dataReceived")).toBe(0);
        expect(replacement.listenerCount("dataReceived")).toBe(1);
        replacement.emit("dataReceived", new Uint8Array([1]), 0, 0);
        expect(listener).toHaveBeenCalledOnce();
        f.media$.next([]);
        expect(replacement.listenerCount("dataReceived")).toBe(0);
        f.media$.next([{ local: false, userId: "@bob:example.org", microphoneParticipant$: f.participant$ }]);
        expect(replacement.listenerCount("dataReceived")).toBe(1);
        f.disposed$.next();
        expect(replacement.listenerCount("dataReceived")).toBe(0);
    });

    it("uses the existing call keys with LiveKit's encryption option for both media and data", () => {
        const start = source.indexOf("function W4(");
        const end = source.indexOf("\n//#endregion", start);
        expect(start).toBeGreaterThan(-1);
        const setting = { getValue: () => true };
        const options = new Function("H4", "N", "Ae", "Ye", "b", `${source.slice(start, end)}; return W4;`)(
            () => ({}),
            { getValue: () => false },
            setting,
            setting,
            setting,
        ) as (input: unknown) => Record<string, unknown>;
        const keys = { keyProvider: {}, worker: {} };
        const selected$ = { value: { id: "device" } };
        const result = options({
            devices: { audioInput: { selected$ }, videoInput: { selected$ }, audioOutput: { selected$ } },
            processorState: {},
            e2eeLivekitOptions: keys,
            controlledAudioDevices: false,
        });
        expect(result.encryption).toBe(keys);
        expect(result.e2ee).toBeUndefined();
    });

    it("binds the engine adapter to the component host and releases it when the engine ends", async () => {
        const start = source.indexOf("\tif (p.notifySoundboardTransport) {");
        const end = source.indexOf("\t// Aether: deafening only silences", start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const notifySoundboardTransport = vi.fn().mockResolvedValue(undefined);
        const transport = fixture().transport;
        const factory = vi.fn().mockReturnValue(transport);
        const dispose: (() => void)[] = [];
        new Function("p", "e", "A", "ue", "l", "aetherCreateSoundboardTransport", source.slice(start, end))(
            { notifySoundboardTransport },
            { onEnd: (callback: () => void) => dispose.push(callback) },
            {},
            {},
            { warn: vi.fn() },
            factory,
        );
        expect(notifySoundboardTransport).toHaveBeenCalledWith(transport);
        dispose.forEach((callback) => callback());
        expect(notifySoundboardTransport).toHaveBeenLastCalledWith(null);
    });
});
