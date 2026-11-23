/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnownMembership, type MatrixClient, type Room, RoomType } from "matrix-js-sdk/src/matrix";

import dispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { waitForRoom } from "../../utils/room/waitForRoom";
import { type ServerChannel } from "../../utils/servers/serverChannels";
import { PreviewRoomAvatarData } from "./PreviewRoomAvatarData";
import { UnjoinedChannelItemViewModel } from "./UnjoinedChannelItemViewModel";

vi.mock("../../utils/room/waitForRoom", () => ({ waitForRoom: vi.fn() }));
vi.mock("../../customisations/Media", () => ({
    mediaFromMxc: (mxc: string) => ({ getThumbnailOfSourceHttp: () => `https://media/${mxc.slice(6)}` }),
}));

const channel = (extra: Partial<ServerChannel> = {}): ServerChannel => ({
    roomId: "!news:example.org",
    name: "news",
    kind: "text",
    memberCount: 3,
    suggested: false,
    via: ["example.org"],
    ...extra,
});

const lounge = channel({
    roomId: "!lounge:example.org",
    name: "Lounge",
    kind: "voice",
    roomType: RoomType.UnstableCall,
});

describe("UnjoinedChannelItemViewModel", () => {
    let client: MatrixClient;
    let joined: Room;

    beforeEach(() => {
        client = { joinRoom: vi.fn().mockResolvedValue({}) } as unknown as MatrixClient;
        joined = { roomId: lounge.roomId, getMyMembership: () => KnownMembership.Join } as Room;
        vi.mocked(waitForRoom).mockResolvedValue(joined);
        vi.spyOn(dispatcher, "dispatch").mockImplementation(() => {});
    });

    afterEach(() => vi.restoreAllMocks());

    it("looks like any channel of the server, with its menus hidden", () => {
        const vm = new UnjoinedChannelItemViewModel({
            client,
            channel: channel({ avatarUrl: "mxc://example.org/icon" }),
        });
        expect(vm.roomId).toBe("!news:example.org");
        expect(vm.getSnapshot()).toMatchObject({
            id: "!news:example.org",
            name: "news",
            channelKind: "text",
            channelIconUrl: "https://media/example.org/icon",
            isBold: false,
            notification: { hasAnyNotificationOrActivity: false, isMention: false },
            showMoreOptionsMenu: false,
            showNotificationMenu: false,
            canChangeSection: false,
        });
        expect(vm.getSnapshot().room).toBeInstanceOf(PreviewRoomAvatarData);
    });

    it("opens a text channel and joins it there", () => {
        new UnjoinedChannelItemViewModel({ client, channel: channel() }).onOpenRoom();
        expect(dispatcher.dispatch).toHaveBeenCalledWith({
            action: Action.ViewRoom,
            room_id: "!news:example.org",
            auto_join: true,
            via_servers: ["example.org"],
            metricsTrigger: "RoomList",
        });
        expect(client.joinRoom).not.toHaveBeenCalled();
    });

    it("joins a voice channel, then its call where the user is", async () => {
        const joinCall = vi.spyOn(SDKContextClass.instance.roomViewStore, "joinVoiceChannel").mockReturnValue(true);
        const vm = new UnjoinedChannelItemViewModel({ client, channel: lounge });
        vm.onOpenRoom();
        vm.onOpenRoom(); // a second click while joining does nothing more
        await vi.waitFor(() => expect(joinCall).toHaveBeenCalledWith(joined));
        expect(client.joinRoom).toHaveBeenCalledTimes(1);
        expect(client.joinRoom).toHaveBeenCalledWith(lounge.roomId, { viaServers: ["example.org"] });
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("opens a joined voice channel when its call can't be joined from where the user is", async () => {
        vi.spyOn(SDKContextClass.instance.roomViewStore, "joinVoiceChannel").mockReturnValue(false);
        new UnjoinedChannelItemViewModel({ client, channel: lounge }).onOpenRoom();
        await vi.waitFor(() =>
            expect(dispatcher.dispatch).toHaveBeenCalledWith({
                action: Action.ViewRoom,
                room_id: lounge.roomId,
                metricsTrigger: "RoomList",
            }),
        );
    });

    it("opens a voice channel it could not join, to say why", async () => {
        vi.mocked(client.joinRoom).mockRejectedValue(new Error("forbidden"));
        new UnjoinedChannelItemViewModel({ client, channel: lounge }).onOpenRoom();
        await vi.waitFor(() =>
            expect(dispatcher.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({ action: Action.ViewRoom, room_id: lounge.roomId, auto_join: true }),
            ),
        );
        expect(waitForRoom).not.toHaveBeenCalled();
    });

    it("does nothing more when a joined voice channel never arrives", async () => {
        vi.mocked(waitForRoom).mockResolvedValue(null);
        const joinCall = vi.spyOn(SDKContextClass.instance.roomViewStore, "joinVoiceChannel");
        new UnjoinedChannelItemViewModel({ client, channel: lounge }).onOpenRoom();
        await vi.waitFor(() => expect(waitForRoom).toHaveBeenCalled());
        await Promise.resolve();
        expect(joinCall).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("does nothing for the actions of the hidden menus", () => {
        const vm = new UnjoinedChannelItemViewModel({ client, channel: channel() });
        for (const action of [
            vm.onMarkAsRead,
            vm.onMarkAsUnread,
            vm.onToggleFavorite,
            vm.onToggleLowPriority,
            vm.onInvite,
            vm.onCopyRoomLink,
            vm.onLeaveRoom,
            vm.onCreateSection,
            vm.onSetRoomNotifState,
            vm.onToggleSection,
            vm.onRemoveFromSection,
        ]) {
            action();
        }
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
        expect(client.joinRoom).not.toHaveBeenCalled();
    });
});
