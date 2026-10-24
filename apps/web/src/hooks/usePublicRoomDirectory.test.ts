/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor, renderHook, act } from "test-utils-rtl";
import { type IRoomDirectoryOptions, type MatrixClient, RoomType } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils/test-utils";

import { usePublicRoomDirectory } from "./usePublicRoomDirectory";
import { MatrixClientPeg } from "../MatrixClientPeg";

function render() {
    return renderHook(() => usePublicRoomDirectory());
}

describe("usePublicRoomDirectory", () => {
    let cli: MatrixClient;

    beforeEach(() => {
        stubClient();
        cli = MatrixClientPeg.safeGet();

        cli.getDomain = () => "matrix.org";
        cli.getThirdpartyProtocols = () => Promise.resolve({});
        cli.publicRooms = ({ filter }: IRoomDirectoryOptions) => {
            const chunk = [
                {
                    room_id: "hello world!",
                    name: filter?.generic_search_term ?? "", // If the query is "" no filter is applied(an is undefined here), in keeping with the pattern let's call the room ""
                    world_readable: true,
                    guest_can_join: true,
                    num_joined_members: 1,
                },
            ];
            return Promise.resolve({
                chunk,
                total_room_count_estimate: 1,
            });
        };
    });

    it("should display public rooms when searching", async () => {
        const query = "ROOM NAME";
        const { result } = render();

        expect(result.current.ready).toBe(false);
        expect(result.current.loading).toBe(false);

        await act(async () => {
            await result.current.search({
                limit: 1,
                query,
            });
        });

        await waitFor(() => {
            expect(result.current.ready).toBe(true);
        });

        expect(result.current.publicRooms[0].name).toBe(query);
    });

    it("should work with empty queries", async () => {
        const query = "";
        const { result } = render();

        await act(async () => {
            await result.current.search({
                limit: 1,
                query,
            });
        });

        await waitFor(() => {
            expect(result.current.ready).toBe(true);
            expect(result.current.publicRooms[0]?.name).toEqual(query);
        });
    });

    it("should recover from a server exception", async () => {
        cli.publicRooms = () => {
            throw new Error("Oops");
        };
        const query = "ROOM NAME";

        const { result } = render();

        await act(async () => {
            await result.current.search({
                limit: 1,
                query,
            });
        });

        await waitFor(() => {
            expect(result.current.ready).toBe(true);
        });

        expect(result.current.publicRooms).toEqual([]);
    });

    it.each([
        { stable: true, unstable: false },
        { stable: false, unstable: true },
    ])(
        "should send a Space filter with stable=$stable and unstable=$unstable support",
        async ({ stable, unstable }) => {
            vi.mocked(cli.isVersionSupported).mockResolvedValue(stable);
            vi.mocked(cli.doesServerSupportUnstableFeature).mockResolvedValue(unstable);
            const publicRooms = vi.spyOn(cli, "publicRooms");
            const { result } = render();

            await act(async () => {
                await result.current.search({ limit: 50, query: "Matrix", roomTypes: new Set([RoomType.Space]) });
            });

            expect(publicRooms).toHaveBeenCalledWith(
                expect.objectContaining({ filter: { generic_search_term: "Matrix", room_types: [RoomType.Space] } }),
            );
        },
    );

    it.each([true, false])(
        "should exclude ordinary rooms from Space discovery when filtering is supported=%s",
        async (supported) => {
            vi.mocked(cli.isVersionSupported).mockResolvedValue(supported);
            vi.mocked(cli.doesServerSupportUnstableFeature).mockResolvedValue(false);
            const room = {
                room_id: "!room:matrix.org",
                name: "Public room",
                world_readable: false,
                guest_can_join: false,
                num_joined_members: 1,
            };
            const space = { ...room, room_id: "!space:matrix.org", name: "Public space", room_type: RoomType.Space };
            const publicRooms = vi.spyOn(cli, "publicRooms").mockResolvedValue({ chunk: [room, space] });
            const { result } = render();

            await act(async () => {
                await result.current.search({ limit: 50, query: "", roomTypes: new Set([RoomType.Space]) });
            });

            expect(result.current.publicRooms).toEqual([space]);
            expect(publicRooms).toHaveBeenCalledWith(
                expect.objectContaining({
                    filter: { generic_search_term: "", room_types: supported ? [RoomType.Space] : undefined },
                }),
            );
        },
    );
});
