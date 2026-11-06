/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { JoinRule, KnownMembership, type MatrixClient, Preset, type Room, RoomType } from "matrix-js-sdk/src/matrix";

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
            },
        );
        expect(onStep.mock.calls).toEqual([["server"], ["channels"]]);
        const shared = {
            parentSpace: space,
            suggested: true,
            andView: false,
            joinRule: JoinRule.Restricted,
            encryption: true,
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
