/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    HistoryVisibility,
    JoinRule,
    KnownMembership,
    type MatrixClient,
    Preset,
    type Room,
    RoomType,
} from "matrix-js-sdk/src/matrix";

import createRoom from "../../createRoom";
import { createSpace } from "../../components/views/spaces/SpaceCreateMenu";
import { privateShouldBeEncrypted } from "../rooms";
import { waitForRoom } from "../room/waitForRoom";
import { createServer } from "./createServer";

vi.mock("../../createRoom", () => ({ default: vi.fn() }));
vi.mock("../../components/views/spaces/SpaceCreateMenu", () => ({ createSpace: vi.fn() }));
vi.mock("../rooms", () => ({ privateShouldBeEncrypted: vi.fn() }));
vi.mock("../room/waitForRoom", () => ({ waitForRoom: vi.fn() }));

describe("createServer", () => {
    const client = {} as MatrixClient;
    const space = { roomId: "!space:x", isSpaceRoom: () => true } as unknown as Room;
    const avatar = new File(["icon"], "icon.png");

    beforeEach(() => {
        vi.mocked(createSpace).mockResolvedValue("!space:x");
        vi.mocked(createRoom).mockImplementation(async (_client, opts) =>
            opts.roomType === RoomType.UnstableCall ? "!voice:x" : "!text:x",
        );
        vi.mocked(waitForRoom).mockImplementation(async (_client, roomId) => (roomId === "!space:x" ? space : null));
        vi.mocked(privateShouldBeEncrypted).mockReturnValue(true);
    });

    it("creates a private friends server with a general text and a General voice channel", async () => {
        const onStep = vi.fn();
        await expect(
            createServer(client, { name: "Alice's server", audience: "friends", avatar }, onStep),
        ).resolves.toEqual({ spaceId: "!space:x", textChannelId: "!text:x", voiceChannelId: "!voice:x" });

        expect(createSpace).toHaveBeenCalledWith(
            client,
            "Alice's server",
            false,
            undefined,
            undefined,
            avatar,
            {},
            {
                andView: false,
                joinRule: JoinRule.Knock,
            },
        );
        expect(onStep.mock.calls).toEqual([["server"], ["channels"]]);
        const shared = {
            parentSpace: space,
            suggested: true,
            andView: false,
            joinRule: JoinRule.Restricted,
            encryption: true,
            historyVisibility: HistoryVisibility.Shared,
            createOpts: { preset: Preset.PrivateChat },
        };
        expect(createRoom).toHaveBeenCalledWith(client, expect.objectContaining({ ...shared, name: "general" }));
        expect(createRoom).toHaveBeenCalledWith(
            client,
            expect.objectContaining({ ...shared, name: "General", roomType: RoomType.UnstableCall }),
        );
        // The text channel is opened afterwards, so creation waits until it is joined.
        const joined = vi.mocked(waitForRoom).mock.calls.find(([, roomId]) => roomId === "!text:x")![2];
        expect(joined({ getMyMembership: () => KnownMembership.Join } as Room)).toBe(true);
    });

    it("gives each channel its own room options", async () => {
        // createRoom writes the name and room type into createOpts and only sends the request after an await, as
        // the real one does, so both channels are in flight together.
        const sent: Array<{ name?: string; type?: string }> = [];
        vi.mocked(createRoom).mockImplementation(async (_client, opts) => {
            const createOpts = opts.createOpts as { name?: string; creation_content?: { type?: string } };
            createOpts.name = opts.name;
            if (opts.roomType) createOpts.creation_content = { type: opts.roomType };
            await Promise.resolve();
            sent.push({ name: createOpts.name, type: createOpts.creation_content?.type });
            return opts.roomType === RoomType.UnstableCall ? "!voice:x" : "!text:x";
        });

        await createServer(client, { name: "Alice's server", audience: "friends" });

        expect(sent).toEqual([
            { name: "general", type: undefined },
            { name: "General", type: RoomType.UnstableCall },
        ]);
    });

    it("makes a community server and its channels public", async () => {
        await createServer(client, { name: "Club", audience: "community" });
        expect(createSpace).toHaveBeenCalledWith(
            client,
            "Club",
            true,
            undefined,
            undefined,
            undefined,
            {},
            {
                andView: false,
            },
        );
        expect(createRoom).toHaveBeenCalledWith(
            client,
            expect.objectContaining({
                joinRule: undefined,
                encryption: false,
                createOpts: { preset: Preset.PublicChat },
            }),
        );
        // Public channels already show their history to anyone through their preset.
        for (const [, opts] of vi.mocked(createRoom).mock.calls) expect(opts.historyVisibility).toBeUndefined();
    });

    it("fails when the server never arrives or a channel is not created", async () => {
        vi.mocked(waitForRoom).mockResolvedValue(null);
        await expect(createServer(client, { name: "A", audience: "friends" })).rejects.toThrow();

        vi.mocked(waitForRoom).mockResolvedValue(space);
        vi.mocked(createRoom).mockResolvedValue(null);
        await expect(createServer(client, { name: "A", audience: "friends" })).rejects.toThrow();

        vi.mocked(createSpace).mockResolvedValue(null);
        await expect(createServer(client, { name: "A", audience: "friends" })).rejects.toThrow();
    });
});
