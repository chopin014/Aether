/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent } from "matrix-js-sdk/src/matrix";

import { AetherPresenceStore, AetherPresenceStoreEvent } from "./AetherPresenceStore";
import { AETHER_PRESENCE_EVENT_TYPE, PRESENCE_TTL_MS, parseAetherPresence } from "./aetherPresence";
import { makeFakeClient } from "../test/test-utils/aetherPresence";

const NOW = 1_700_000_000_000;
const BOB = "@bob:example.org";

describe("parseAetherPresence", () => {
    const valid = { v: 1, presence: "online", ttl_ms: 1000, ts: NOW };
    it("accepts valid content and clamps the lifetime", () => {
        expect(parseAetherPresence(valid)).toEqual(valid);
        expect(parseAetherPresence({ ...valid, ttl_ms: 10 ** 12 })?.ttl_ms).toBe(PRESENCE_TTL_MS);
        expect(parseAetherPresence({ ...valid, last_active_ago: 5 })?.last_active_ago).toBe(5);
    });
    it.each([
        null,
        "online",
        {},
        { ...valid, v: 2 },
        { ...valid, presence: "invisible" },
        { ...valid, ttl_ms: 0 },
        { ...valid, ttl_ms: "1000" },
        { ...valid, ts: NaN },
        { ...valid, ts: undefined },
    ])("rejects malformed content %j", (content) => {
        expect(parseAetherPresence(content)).toBeUndefined();
    });
    it("drops a bad optional last_active_ago", () => {
        expect(parseAetherPresence({ ...valid, last_active_ago: -4 })).not.toHaveProperty("last_active_ago");
    });
});

describe("AetherPresenceStore", () => {
    let now: number;
    beforeEach(() => {
        vi.useFakeTimers();
        now = NOW;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const setup = (opts: Parameters<typeof makeFakeClient>[0] = {}) => {
        const client = makeFakeClient({ rooms: [{ id: "!r", members: [BOB, "@me:example.org"] }], ...opts });
        const store = new AetherPresenceStore(client, () => now);
        store.start();
        const receive = (
            content: unknown,
            { sender = BOB, encrypted = true, type = AETHER_PRESENCE_EVENT_TYPE } = {},
        ): void => {
            client.emit(ClientEvent.ReceivedToDeviceMessage, {
                message: { type, sender, content },
                encryptionInfo: encrypted ? { sender } : null,
            } as never);
        };
        return { client, store, receive };
    };
    const signal = (presence = "online", ts = NOW, ttl = PRESENCE_TTL_MS) => ({ v: 1, presence, ts, ttl_ms: ttl });

    it("stores a valid encrypted signal and notifies listeners", () => {
        const { store, receive } = setup();
        const listener = vi.fn();
        store.on(AetherPresenceStoreEvent.Update, listener);
        receive(signal("unavailable"));
        expect(store.getSignal(BOB)).toEqual({ presence: "unavailable", lastSeen: NOW, expired: false });
        expect(listener).toHaveBeenCalledWith(BOB);
    });

    it("ignores plaintext, wrong type, malformed content, strangers, ignored users, self and stale signals", () => {
        const { store, receive } = setup({ ignored: ["@ign:example.org"] });
        receive(signal(), { encrypted: false });
        receive(signal(), { type: "io.other" });
        receive({ nonsense: true });
        receive(signal(), { sender: "@stranger:example.org" });
        receive(signal(), { sender: "@ign:example.org" });
        receive(signal(), { sender: "@me:example.org" });
        receive(signal("online", NOW - PRESENCE_TTL_MS - 1));
        for (const id of [BOB, "@stranger:example.org", "@ign:example.org", "@me:example.org"]) {
            expect(store.getSignal(id)).toBeUndefined();
        }
    });

    it("rejects a message whose Olm sender differs from the claimed sender", () => {
        const { client, store } = setup();
        client.emit(ClientEvent.ReceivedToDeviceMessage, {
            message: { type: AETHER_PRESENCE_EVENT_TYPE, sender: BOB, content: signal() },
            encryptionInfo: { sender: "@eve:example.org" },
        } as never);
        expect(store.getSignal(BOB)).toBeUndefined();
    });

    it("drops older signals that arrive after newer ones", () => {
        const { store, receive } = setup();
        receive(signal("online", NOW));
        receive(signal("offline", NOW - 1000));
        expect(store.getSignal(BOB)?.presence).toBe("online");
        receive(signal("unavailable", NOW + 1000));
        expect(store.getSignal(BOB)?.presence).toBe("unavailable");
    });

    it("expires to offline after the lifetime, notifying once, and keeps when it was last seen", () => {
        const { store, receive } = setup();
        const listener = vi.fn();
        receive(signal("online"));
        store.on(AetherPresenceStoreEvent.Update, listener);
        now += PRESENCE_TTL_MS - 1;
        expect(store.getSignal(BOB)?.presence).toBe("online");
        now += 1;
        vi.advanceTimersByTime(PRESENCE_TTL_MS + 5);
        expect(store.getSignal(BOB)).toEqual({ presence: "offline", lastSeen: NOW, expired: true });
        expect(listener).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(PRESENCE_TTL_MS * 3);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("treats an announced offline as final, not as expired", () => {
        const { store, receive } = setup();
        receive(signal("offline"));
        now += PRESENCE_TTL_MS * 2;
        expect(store.getSignal(BOB)).toEqual({ presence: "offline", lastSeen: NOW, expired: false });
    });

    it("stops listening and forgets everything when stopped", () => {
        const { store, receive } = setup();
        receive(signal());
        store.stop();
        expect(store.getSignal(BOB)).toBeUndefined();
        receive(signal("unavailable", NOW + 5));
        expect(store.getSignal(BOB)).toBeUndefined();
    });
});
