/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { CreateServerViewModel } from "./CreateServerViewModel";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { OwnProfileStore } from "../../stores/OwnProfileStore";
import { Filter } from "../../components/views/dialogs/spotlight/Filter";
import { type createServer as defaultCreateServer } from "../../utils/servers/createServer";

describe("CreateServerViewModel", () => {
    let client: MatrixClient;
    let createServer: Mock<typeof defaultCreateServer>;
    const spaceStore = { setActiveSpace: vi.fn() };
    const onFinished = vi.fn();

    const make = (canChooseAudience = true): CreateServerViewModel =>
        new CreateServerViewModel({ client, onFinished, canChooseAudience, createServer, spaceStore });

    beforeEach(() => {
        client = {
            getUserIdLocalpart: () => "alice",
            isVersionSupported: vi.fn().mockResolvedValue(false),
            doesServerSupportUnstableFeature: vi.fn().mockResolvedValue(true),
        } as unknown as MatrixClient;
        createServer = vi
            .fn<typeof defaultCreateServer>()
            .mockResolvedValue({ spaceId: "!s:x", textChannelId: "!t:x", voiceChannelId: "!v:x" });
        vi.spyOn(OwnProfileStore.instance, "displayName", "get").mockReturnValue("Alice");
        vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
        URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
        URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => vi.restoreAllMocks());

    it("starts on the first screen with a name made from the user's", async () => {
        const vm = make();
        expect(vm.getSnapshot()).toMatchObject({ step: "start", name: "Alice's server", audience: "friends" });
        await vi.waitFor(() => expect(vm.getSnapshot().canExplore).toBe(true));
    });

    it("falls back to the user ID's localpart for the default name", () => {
        vi.spyOn(OwnProfileStore.instance, "displayName", "get").mockReturnValue(null);
        expect(make().getSnapshot().name).toBe("alice's server");
    });

    it("walks create → audience → customise and back", () => {
        const vm = make();
        vm.startCreate();
        expect(vm.getSnapshot().step).toBe("audience");
        vm.chooseAudience("community");
        expect(vm.getSnapshot()).toMatchObject({ step: "customise", audience: "community" });
        vm.back();
        expect(vm.getSnapshot().step).toBe("audience");
        vm.back();
        expect(vm.getSnapshot().step).toBe("start");
    });

    it("skips the audience question when community servers are not allowed", () => {
        const vm = make(false);
        vm.startCreate();
        expect(vm.getSnapshot().step).toBe("customise");
        vm.back();
        expect(vm.getSnapshot().step).toBe("start");
    });

    it("previews the icon and frees replaced previews", () => {
        const vm = make();
        vm.setAvatar(new File(["a"], "a.png"));
        expect(vm.getSnapshot().avatarUrl).toBe("blob:a.png");
        vm.setAvatar(new File(["b"], "b.png"));
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a.png");
        vm.dispose();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:b.png");
    });

    it("creates the server, switches to it and opens its text channel", async () => {
        const vm = make();
        const avatar = new File(["a"], "a.png");
        vm.setAvatar(avatar);
        vm.chooseAudience("community");
        vm.setName("  Club  ");
        createServer.mockImplementation(async (_client, _opts, onStep) => {
            onStep?.("channels");
            expect(vm.getSnapshot()).toMatchObject({ busy: true, progress: "Setting up channels…" });
            return { spaceId: "!s:x", textChannelId: "!t:x", voiceChannelId: "!v:x" };
        });

        await vm.create();

        expect(createServer).toHaveBeenCalledWith(
            client,
            { name: "Club", audience: "community", avatar },
            expect.any(Function),
        );
        expect(spaceStore.setActiveSpace).toHaveBeenCalledWith("!s:x", false);
        expect(defaultDispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, room_id: "!t:x" }),
        );
        expect(onFinished).toHaveBeenCalled();
    });

    it("does nothing without a name and reports failures", async () => {
        const vm = make();
        vm.setName("   ");
        await vm.create();
        expect(createServer).not.toHaveBeenCalled();

        vm.setName("Club");
        createServer.mockRejectedValue(new Error("nope"));
        await vm.create();
        expect(vm.getSnapshot()).toMatchObject({
            busy: false,
            error: "Your server could not be created. Check your connection and try again.",
        });
    });

    it("joins a typed invite through the room view", () => {
        const vm = make();
        vm.startJoin();
        vm.setJoinAddress("nonsense");
        vm.join();
        expect(vm.getSnapshot().error).toMatch(/doesn't look right/);
        expect(onFinished).not.toHaveBeenCalled();

        vm.setJoinAddress("#aether:matrix.org");
        expect(vm.getSnapshot().error).toBeUndefined();
        vm.join();
        expect(defaultDispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.ViewRoom,
                room_alias: "#aether:matrix.org",
                via_servers: [],
                auto_join: true,
            }),
        );
        expect(onFinished).toHaveBeenCalled();
    });

    it("opens the public server directory", () => {
        make().explore();
        expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
            action: Action.OpenSpotlight,
            initialFilter: Filter.PublicSpaces,
        });
    });
});
