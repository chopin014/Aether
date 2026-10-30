/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, MatrixError, TypedEventEmitter, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import { PROFILE_UPDATED_EVENT_TYPE, RichProfileStore } from "./RichProfileStore";
import { RICH_PROFILE_FIELD } from "./richProfile";

const ME = "@me:example.org";
const ROBIN = "@robin:example.org";

function makeClient(overrides: Record<string, unknown> = {}): MatrixClient {
    const emitter = new TypedEventEmitter<string, any>();
    return Object.assign(emitter, {
        doesServerSupportExtendedProfiles: vi.fn().mockResolvedValue(true),
        getExtendedProfile: vi.fn().mockResolvedValue({ [RICH_PROFILE_FIELD]: { decoration: "halo" } }),
        getUserId: () => ME,
        isUserIgnored: vi.fn().mockReturnValue(false),
        getIgnoredUsers: () => [],
        getAccountData: () => undefined,
        getRooms: () => [
            {
                getMyMembership: () => KnownMembership.Join,
                getMember: () => ({ membership: KnownMembership.Join }),
                getJoinedMemberCount: () => 2,
                getJoinedMembers: () => [{ userId: ROBIN }],
            },
        ],
        getCrypto: vi.fn(),
        queueToDevice: vi.fn(),
        ...overrides,
    }) as unknown as MatrixClient;
}

function hint(encryptedBy: string | null = ROBIN): unknown {
    return {
        message: { type: PROFILE_UPDATED_EVENT_TYPE, sender: ROBIN, content: { v: 1 } },
        encryptionInfo: encryptedBy ? { sender: encryptedBy } : null,
    };
}

describe("RichProfileStore", () => {
    let now = 1_000_000;
    const clock = (): number => now;
    beforeEach(() => {
        now = 1_000_000;
    });

    it("makes one request however many rows ask at once", async () => {
        const client = makeClient();
        const store = new RichProfileStore(client, clock);
        await Promise.all([store.request(ROBIN), store.request(ROBIN), store.request(ROBIN)]);
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(1);
        expect(store.get(ROBIN)?.decoration).toBe("halo");
    });

    it("serves a fresh profile from memory, and refetches once it goes stale", async () => {
        const client = makeClient();
        const store = new RichProfileStore(client, clock);
        await store.request(ROBIN);
        now += 60 * 1000;
        await store.request(ROBIN);
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(1);
        now += 10 * 60 * 1000;
        await store.request(ROBIN);
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(2);
    });

    it("accepts less staleness when someone opens the profile on purpose", async () => {
        const client = makeClient();
        const store = new RichProfileStore(client, clock);
        await store.request(ROBIN);
        now += 60 * 1000;
        await store.request(ROBIN, { onOpen: true });
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(2);
    });

    it("never runs more than a few lookups at once", async () => {
        let running = 0;
        let peak = 0;
        const client = makeClient({
            getExtendedProfile: vi.fn(async () => {
                running++;
                peak = Math.max(peak, running);
                await new Promise((resolve) => setTimeout(resolve, 1));
                running--;
                return {};
            }),
        });
        const store = new RichProfileStore(client, clock);
        await Promise.all(Array.from({ length: 30 }, (_, i) => store.request(`@user${i}:example.org`)));
        expect(peak).toBeLessThanOrEqual(4);
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(30);
    });

    it("does not ask a server that has no extended profiles", async () => {
        const client = makeClient({ doesServerSupportExtendedProfiles: vi.fn().mockResolvedValue(false) });
        const store = new RichProfileStore(client, clock);
        await store.request(ROBIN);
        expect(client.getExtendedProfile).not.toHaveBeenCalled();
        expect(store.get(ROBIN)).toMatchObject({ links: [], board: [] });
    });

    it("remembers a failure for a while instead of hammering a remote server", async () => {
        const client = makeClient({
            getExtendedProfile: vi.fn().mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403)),
        });
        const store = new RichProfileStore(client, clock);
        await store.request(ROBIN);
        now += 20 * 60 * 1000;
        await store.request(ROBIN, { onOpen: true });
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(1);
        now += 11 * 60 * 1000;
        await store.request(ROBIN);
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(2);
    });

    it("tells subscribers about new data and stops when they leave", async () => {
        const store = new RichProfileStore(makeClient(), clock);
        const listener = vi.fn();
        const unsubscribe = store.subscribe(ROBIN, listener);
        await store.request(ROBIN);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        store.set(ROBIN, {});
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("refetches when sync reports a change (MSC4429), but only if someone is looking", async () => {
        const client = makeClient();
        const store = new RichProfileStore(client, clock);
        await store.request(ROBIN);
        client.emit(ClientEvent.UserProfileUpdate, ROBIN, {});
        expect(store.get(ROBIN)).toBeUndefined();
        expect(client.getExtendedProfile).toHaveBeenCalledTimes(1);
        const unsubscribe = store.subscribe(ROBIN, () => {});
        client.emit(ClientEvent.UserProfileUpdate, ROBIN, {});
        await vi.waitFor(() => expect(client.getExtendedProfile).toHaveBeenCalledTimes(2));
        unsubscribe();
    });

    describe("update hints", () => {
        const emitHint = (client: MatrixClient, payload: unknown): void => {
            client.emit(ClientEvent.ReceivedToDeviceMessage, payload as never);
        };

        async function primed(overrides: Record<string, unknown> = {}): Promise<[MatrixClient, RichProfileStore]> {
            const client = makeClient(overrides);
            const store = new RichProfileStore(client, clock);
            store.subscribe(ROBIN, () => {});
            await store.request(ROBIN);
            vi.mocked(client.getExtendedProfile).mockClear();
            return [client, store];
        }

        it("re-reads the profile when someone we share a room with announces a change", async () => {
            const [client] = await primed();
            emitHint(client, hint());
            await vi.waitFor(() => expect(client.getExtendedProfile).toHaveBeenCalledTimes(1));
        });

        it.each([
            ["unencrypted", hint(null)],
            ["from someone else's session", hint("@mallory:example.org")],
        ])("ignores a hint that is %s", async (_, payload) => {
            const [client] = await primed();
            emitHint(client, payload);
            await new Promise((resolve) => setTimeout(resolve, 1));
            expect(client.getExtendedProfile).not.toHaveBeenCalled();
        });

        it("ignores strangers and ignored people", async () => {
            const [stranger] = await primed({ getRooms: () => [] });
            emitHint(stranger, hint());
            const [ignored] = await primed({ isUserIgnored: () => true });
            emitHint(ignored, hint());
            await new Promise((resolve) => setTimeout(resolve, 1));
            expect(stranger.getExtendedProfile).not.toHaveBeenCalled();
            expect(ignored.getExtendedProfile).not.toHaveBeenCalled();
        });

        it("cannot be used to make us refetch in a tight loop", async () => {
            const [client] = await primed();
            emitHint(client, hint());
            await vi.waitFor(() => expect(client.getExtendedProfile).toHaveBeenCalledTimes(1));
            for (let i = 0; i < 5; i++) emitHint(client, hint());
            await new Promise((resolve) => setTimeout(resolve, 1));
            expect(client.getExtendedProfile).toHaveBeenCalledTimes(1);
            now += 31 * 1000;
            emitHint(client, hint());
            await vi.waitFor(() => expect(client.getExtendedProfile).toHaveBeenCalledTimes(2));
        });

        it("announces an update, encrypted, to the devices of people in small rooms", async () => {
            const encryptToDeviceMessages = vi.fn().mockResolvedValue({ batch: [{ userId: ROBIN, deviceId: "A" }] });
            const client = makeClient({
                getCrypto: () => ({
                    getUserDeviceInfo: vi.fn().mockResolvedValue(new Map([[ROBIN, new Map([["A", {}]])]])),
                    encryptToDeviceMessages,
                }),
            });
            await new RichProfileStore(client, clock).announceUpdate();
            expect(encryptToDeviceMessages).toHaveBeenCalledWith(
                PROFILE_UPDATED_EVENT_TYPE,
                [{ userId: ROBIN, deviceId: "A" }],
                { v: 1 },
            );
            expect(client.queueToDevice).toHaveBeenCalled();
        });
    });
});
