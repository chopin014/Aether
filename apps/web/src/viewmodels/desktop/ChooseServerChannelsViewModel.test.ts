/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { ChooseServerChannelsViewModel } from "./ChooseServerChannelsViewModel";
import { type ServerChannel } from "../../utils/servers/serverChannels";

const channel = (roomId: string, kind: "text" | "voice" = "text"): ServerChannel => ({
    roomId,
    name: roomId.slice(1),
    kind,
    topic: kind === "text" ? "Chat" : undefined,
    memberCount: 4,
    suggested: false,
    via: [],
});

describe("ChooseServerChannelsViewModel", () => {
    const client = {} as MatrixClient;
    const space = { roomId: "!space", name: "Gamers" } as Room;
    const channels = [channel("!general"), channel("!memes"), channel("!lounge", "voice")];

    const make = (joinChannels = vi.fn().mockResolvedValue({ joined: ["!general"], failed: [] })) => {
        const props = {
            client,
            space,
            channels,
            initialSelection: new Set(["!general"]),
            onFinished: vi.fn(),
            openFirstChannel: vi.fn().mockResolvedValue(undefined),
            joinChannels,
        };
        return { vm: new ChooseServerChannelsViewModel(props), props };
    };

    it("shows the server's channels with the initial selection", () => {
        const { vm } = make();
        expect(vm.getSnapshot()).toEqual({
            serverName: "Gamers",
            busy: false,
            channels: [
                { id: "!general", name: "general", kind: "text", topic: "Chat", memberCount: 4, selected: true },
                { id: "!memes", name: "memes", kind: "text", topic: "Chat", memberCount: 4, selected: false },
                { id: "!lounge", name: "lounge", kind: "voice", topic: undefined, memberCount: 4, selected: false },
            ],
        });
    });

    it("toggles channels and selects all or none", () => {
        const { vm } = make();
        vm.toggle("!memes");
        vm.toggle("!general");
        expect(vm.getSnapshot().channels.map((c) => c.selected)).toEqual([false, true, false]);
        vm.setAll(true);
        expect(vm.getSnapshot().channels.every((c) => c.selected)).toBe(true);
        vm.setAll(false);
        expect(vm.getSnapshot().channels.some((c) => c.selected)).toBe(false);
    });

    it("joins the selection, closes and opens the first channel", async () => {
        const { vm, props } = make();
        vm.toggle("!lounge");
        await vm.confirm();
        expect(props.joinChannels).toHaveBeenCalledWith(client, [channels[0], channels[2]]);
        expect(props.onFinished).toHaveBeenCalled();
        expect(props.openFirstChannel).toHaveBeenCalledWith(client, "!space", channels, ["!general"]);
    });

    it("does nothing with an empty selection", async () => {
        const { vm, props } = make();
        vm.setAll(false);
        await vm.confirm();
        expect(props.joinChannels).not.toHaveBeenCalled();
    });

    it("stays open to retry when nothing could be joined", async () => {
        const { vm, props } = make(vi.fn().mockResolvedValue({ joined: [], failed: [channels[0]] }));
        await vm.confirm();
        expect(vm.getSnapshot()).toMatchObject({ busy: false, error: expect.stringMatching(/None of the channels/) });
        expect(props.onFinished).not.toHaveBeenCalled();
    });

    it("keeps only the failed channels to retry after a partial failure", async () => {
        const { vm, props } = make(vi.fn().mockResolvedValue({ joined: ["!general"], failed: [channels[1]] }));
        vm.toggle("!memes");
        await vm.confirm();
        expect(vm.getSnapshot().channels.map((c) => [c.id, c.selected])).toEqual([
            ["!memes", true],
            ["!lounge", false],
        ]);
        expect(vm.getSnapshot().error).toBe("Could not join memes. Try again or skip them for now.");
        expect(props.openFirstChannel).toHaveBeenCalled();
        expect(props.onFinished).not.toHaveBeenCalled();
    });

    it("skips", () => {
        const { vm, props } = make();
        vm.skip();
        expect(props.onFinished).toHaveBeenCalled();
    });
});
