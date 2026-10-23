/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, MatrixEvent, SetPresence, User, UserEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import Presence from "../../Presence";
import { PresenceViewModel } from "./PresenceViewModel";
import { MatrixDispatcher } from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import SdkConfig from "../../SdkConfig";
import { presencePreferenceKey, readPresencePreference } from "../../utils/presencePreference";

const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

describe("PresenceViewModel", () => {
    let client: MatrixClient;
    let dispatcher: MatrixDispatcher;
    let vm: PresenceViewModel;
    let user: User;
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        SdkConfig.reset();
        client = stubClient();
        client.setSyncPresence = vi.fn().mockResolvedValue(undefined);
        client.setPresence = vi.fn().mockResolvedValue(undefined);
        user = User.createUser(client.getSafeUserId(), client);
        vi.mocked(client.getUser).mockReturnValue(user);
        dispatcher = new MatrixDispatcher();
        vm = new PresenceViewModel({ client, dispatcher });
    });
    afterEach(() => {
        vm.dispose();
        Presence.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
        SdkConfig.reset();
        localStorage.clear();
    });
    const activity = async () => {
        dispatcher.dispatch({ action: Action.UserActivity }, true);
        await flush();
    };

    it("should share one controller per client and dispose it when the account changes", () => {
        const first = Presence.forClient(client);
        expect(Presence.forClient(client)).toBe(first);
        const other = stubClient();
        expect(Presence.forClient(other)).not.toBe(first);
        expect(first.isDisposed).toBe(true);
        Presence.stop();
        expect(Presence.getState()).toBeNull();
    });

    it("should keep absent self presence unknown until a real offline event arrives", () => {
        expect(user.presence).toBe("offline");
        expect(vm.getSnapshot().current).toBeUndefined();
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "offline" } }));
        client.emit(UserEvent.LastPresenceTs, user.events.presence!, user);
        expect(vm.getSnapshot().current).toBe("offline");
    });

    it("should also receive sync presence for the SDK's own user without a user-event re-emitter", () => {
        const ownUser = new User(client.getSafeUserId());
        vi.mocked(client.getUser).mockReturnValue(ownUser);
        const event = new MatrixEvent({ type: "m.presence", sender: ownUser.userId, content: { presence: "online" } });
        ownUser.setPresenceEvent(event);
        client.emit(ClientEvent.Event, event);
        expect(vm.getSnapshot().current).toBe("online");
    });

    it("should automatically idle and return online on activity", async () => {
        vm.start();
        await flush();
        expect(client.setSyncPresence).toHaveBeenLastCalledWith(SetPresence.Online);
        await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
        expect(client.setSyncPresence).toHaveBeenLastCalledWith(SetPresence.Unavailable);
        await activity();
        expect(client.setSyncPresence).toHaveBeenLastCalledWith(SetPresence.Online);
    });

    it.each(["unavailable", "offline"] as const)(
        "should preserve manual %s through activity and idle",
        async (choice) => {
            vm.start();
            await flush();
            await vm.setPreference(choice);
            expect(client.setPresence).toHaveBeenLastCalledWith({ presence: choice });
            expect(vm.getSnapshot().current).toBeUndefined();
            vi.mocked(client.setSyncPresence).mockClear();
            await activity();
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            expect(client.setSyncPresence).not.toHaveBeenCalled();
            expect(vm.getSnapshot().preference).toBe(choice);
            expect(localStorage.getItem(presencePreferenceKey(client))).toBe(choice);
        },
    );

    it("should resume automatic away when choosing Online", async () => {
        await vm.setPreference("offline");
        await vm.setPreference("online");
        await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
        expect(client.setSyncPresence).toHaveBeenLastCalledWith(SetPresence.Unavailable);
    });

    it("should restore invisible intent on a new controller for the same account and device", async () => {
        await vm.setPreference("offline");
        vm.dispose();
        vm = new PresenceViewModel({ client, dispatcher });
        vm.start();
        await flush();
        expect(vm.getSnapshot().preference).toBe("offline");
        expect(client.setSyncPresence).toHaveBeenLastCalledWith(SetPresence.Offline);
        expect(client.setPresence).toHaveBeenLastCalledWith({ presence: "offline" });
    });

    it("should isolate stored choices by account, homeserver and device", async () => {
        await vm.setPreference("offline");
        const original = presencePreferenceKey(client);
        vi.mocked(client.getUserId).mockReturnValue("@other:example.org");
        expect(readPresencePreference(client)).toBe("online");
        expect(presencePreferenceKey(client)).not.toBe(original);
        vi.mocked(client.getUserId).mockReturnValue(user.userId);
        vi.mocked(client.getDeviceId).mockReturnValue("OTHER_DEVICE");
        expect(readPresencePreference(client)).toBe("online");
        vi.mocked(client.getDeviceId).mockReturnValue("DEVICE");
        const other = Object.create(client) as MatrixClient;
        Object.defineProperty(other, "baseUrl", { value: "https://other.example.org" });
        expect(readPresencePreference(other)).toBe("online");
    });

    it("should retain failed intent without reporting success and retry only on request", async () => {
        vi.mocked(client.setPresence).mockRejectedValueOnce(new Error("network"));
        await vm.setPreference("offline");
        expect(vm.getSnapshot()).toMatchObject({ preference: "offline", busy: false });
        expect(vm.getSnapshot().error).toContain("Could not update presence");
        await activity();
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        expect(client.setPresence).toHaveBeenCalledTimes(1);
        await vm.retry();
        expect(client.setPresence).toHaveBeenCalledTimes(2);
        expect(vm.getSnapshot().error).toBeUndefined();
        expect(vm.getSnapshot().current).toBeUndefined();
    });

    it("should show a storage error, retain intent and allow persistence to be retried", async () => {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new Error("quota");
        });
        await vm.setPreference("offline");
        expect(vm.getSnapshot().error).toContain("Could not save");
        expect(vm.getSnapshot().preference).toBe("offline");
        expect(client.setPresence).not.toHaveBeenCalled();
        vi.mocked(localStorage.setItem).mockRestore();
        await vm.retry();
        expect(vm.getSnapshot().error).toBeUndefined();
        expect(readPresencePreference(client)).toBe("offline");
    });

    it("should suppress duplicate requests until a pending request completes", async () => {
        const pending = Promise.withResolvers<void>();
        vi.mocked(client.setPresence).mockReturnValue(pending.promise);
        const request = vm.setPreference("offline");
        await flush();
        expect(vm.getSnapshot().busy).toBe(true);
        await vm.retry();
        await vm.setPreference("online");
        expect(client.setPresence).toHaveBeenCalledTimes(1);
        pending.resolve();
        await request;
        expect(vm.getSnapshot().busy).toBe(false);
    });

    it("should preserve the last received presence status message", async () => {
        user.presenceStatusMsg = "In a meeting";
        await vm.setPreference("unavailable");
        expect(client.setPresence).toHaveBeenCalledWith({ presence: "unavailable", status_msg: "In a meeting" });
    });

    it("should not offer or send presence when explicitly disabled", async () => {
        vm.dispose();
        SdkConfig.put({ enable_presence_by_hs_url: { [client.baseUrl]: false } });
        vm = new PresenceViewModel({ client, dispatcher });
        vm.start();
        await vm.setPreference("offline");
        await vm.retry();
        expect(vm.getSnapshot().enabled).toBe(false);
        expect(client.setPresence).not.toHaveBeenCalled();
        expect(client.setSyncPresence).not.toHaveBeenCalled();
    });

    it("should clean up timers, activity and user listeners when disposed", async () => {
        const off = vi.spyOn(client, "off");
        vm.start();
        vm.start();
        await flush();
        vi.mocked(client.setSyncPresence).mockClear();
        vm.dispose();
        await activity();
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(client.setSyncPresence).not.toHaveBeenCalled();
        expect(off).toHaveBeenCalledWith(UserEvent.LastPresenceTs, expect.any(Function));
        expect(off).toHaveBeenCalledWith(UserEvent.Presence, expect.any(Function));
    });

    it("should ignore in-flight completion after logout", async () => {
        const pending = Promise.withResolvers<void>();
        vi.mocked(client.setSyncPresence).mockReturnValue(pending.promise);
        const request = vm.setPreference("offline");
        vm.dispose();
        pending.resolve();
        await request;
        expect(client.setPresence).not.toHaveBeenCalled();
    });
});
