/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "test-utils-rtl";
import { ClientEvent, MatrixEvent, RoomEvent, SetPresence, User } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { useMergedPresence } from "./useMergedPresence";
import { AetherPresenceService } from "./AetherPresenceService";
import { AetherPresenceStore } from "./AetherPresenceStore";
import { ActivityTracker } from "./ActivityTracker";
import { AETHER_PRESENCE_EVENT_TYPE, PRESENCE_TTL_MS } from "./aetherPresence";
import Presence from "../Presence";
import dis from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import SettingsStore from "../settings/SettingsStore";
import SdkConfig from "../SdkConfig";
import { makeFakeClient } from "../test/test-utils/aetherPresence";
import { withClientContextRenderOptions } from "../test/test-utils/wrappers";

const BOB = "@bob:example.org";

describe("useMergedPresence", () => {
    let flag: boolean;
    let store: AetherPresenceStore;
    let tracker: ActivityTracker;
    let fake: ReturnType<typeof makeFakeClient>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        SdkConfig.reset();
        flag = true;
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "feature_desktop_shell" ? flag : undefined) as never);
        fake = makeFakeClient({ rooms: [{ id: "!r", members: [BOB, "@me:example.org"] }] });
        store = new AetherPresenceStore(fake);
        store.start();
        tracker = new ActivityTracker(fake);
        tracker.start();
        const service = AetherPresenceService.instance;
        vi.spyOn(service, "store", "get").mockReturnValue(store);
        vi.spyOn(service, "activity", "get").mockReturnValue(tracker);
    });
    afterEach(() => {
        Presence.stop();
        store.stop();
        tracker.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const render = (userId = BOB) => {
        const client = stubClient();
        return { client, ...renderHook(() => useMergedPresence(userId), withClientContextRenderOptions(client)) };
    };
    const sendSignal = (presence: string): void =>
        act(() => {
            fake.emit(ClientEvent.ReceivedToDeviceMessage, {
                message: {
                    type: AETHER_PRESENCE_EVENT_TYPE,
                    sender: BOB,
                    content: { v: 1, presence, ts: Date.now(), ttl_ms: PRESENCE_TTL_MS },
                },
                encryptionInfo: { sender: BOB },
            });
        });

    it("is inert with the desktop shell off", () => {
        flag = false;
        sendSignal("online");
        expect(render().result.current).toBeNull();
    });

    it("shows this device's status without server presence or a self echo and follows changes", async () => {
        const client = stubClient();
        SdkConfig.put({ enable_presence_by_hs_url: { [client.baseUrl]: false } });
        const presence = Presence.forClient(client);
        presence.start();
        const { result, unmount } = renderHook(
            () => useMergedPresence(client.getSafeUserId()),
            withClientContextRenderOptions(client),
        );
        expect(result.current).toEqual({ state: "online", source: "local" });
        for (const state of [SetPresence.Unavailable, SetPresence.Offline, SetPresence.Online]) {
            await act(async () => {
                await presence.setPreference(state);
            });
            expect(result.current).toEqual({ state, source: "local" });
        }
        act(() => {
            vi.advanceTimersByTime(3 * 60_000);
        });
        expect(result.current).toEqual({ state: "unavailable", source: "local" });
        act(() => dis.dispatch({ action: Action.UserActivity }, true));
        expect(result.current).toEqual({ state: "online", source: "local" });
        await act(async () => {
            await presence.setPreference(SetPresence.Offline);
        });
        act(() => dis.dispatch({ action: Action.UserActivity }, true));
        expect(result.current).toEqual({ state: "offline", source: "local" });
        unmount();
    });

    it("keeps this device's Invisible choice over a conflicting server status", async () => {
        const client = stubClient();
        const user = new User(client.getSafeUserId());
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
        vi.mocked(client.getUser).mockReturnValue(user);
        const { result } = renderHook(() => useMergedPresence(user.userId), withClientContextRenderOptions(client));
        await act(async () => {
            await Presence.forClient(client).setPreference(SetPresence.Offline);
        });
        expect(result.current).toEqual({ state: "offline", source: "local" });
    });

    it("does not create a local presence controller with the desktop shell off", () => {
        flag = false;
        const client = stubClient();
        const forClient = vi.spyOn(Presence, "forClient");
        const { result } = renderHook(
            () => useMergedPresence(client.getSafeUserId()),
            withClientContextRenderOptions(client),
        );
        expect(result.current).toBeNull();
        expect(forClient).not.toHaveBeenCalled();
    });

    it("is null without any evidence", () => {
        expect(render().result.current).toBeNull();
    });

    it("follows an Aether signal as it changes", () => {
        const { result } = render();
        sendSignal("online");
        expect(result.current).toMatchObject({ state: "online", source: "aether" });
        sendSignal("unavailable");
        vi.setSystemTime(Date.now() + 1000);
        sendSignal("offline");
        expect(result.current).toMatchObject({ state: "offline", source: "aether" });
    });

    it("shows seen activity, then ages it to amber and grey by itself", () => {
        const { result } = render();
        act(() => {
            fake.emit(
                RoomEvent.Timeline,
                new MatrixEvent({ type: "m.room.message", sender: BOB, origin_server_ts: Date.now(), content: {} }),
                fake.getRooms()[0],
                false,
            );
        });
        expect(result.current).toMatchObject({ state: "online", source: "activity", label: "Active now" });
        act(() => {
            vi.advanceTimersByTime(5 * 60_000 + 100);
        });
        expect(result.current).toMatchObject({ state: "unavailable", source: "activity" });
        act(() => {
            vi.advanceTimersByTime(25 * 60_000 + 100);
        });
        expect(result.current).toMatchObject({ state: "offline", source: "activity" });
    });

    it("lets real server presence win when the config allows it", () => {
        const { result, client } = render();
        const user = new User(BOB);
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "unavailable" } }));
        vi.mocked(client.getUser).mockReturnValue(user);
        sendSignal("online");
        expect(result.current).toMatchObject({ state: "unavailable", source: "server" });
    });

    it("ignores server presence where the config disables it", () => {
        const { result, client } = render();
        SdkConfig.put({ enable_presence_by_hs_url: { [client.baseUrl]: false } });
        const user = new User(BOB);
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "unavailable" } }));
        vi.mocked(client.getUser).mockReturnValue(user);
        sendSignal("online");
        expect(result.current).toMatchObject({ state: "online", source: "aether" });
    });
});
