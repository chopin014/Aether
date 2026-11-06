/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnownMembership, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { defaultChannelSelection, JOIN_ALL_LIMIT, onServerJoined, openFirstChannel } from "./joinServer";
import { joinChannels, listJoinableChannels, type ServerChannel } from "./serverChannels";
import { waitForRoom } from "../room/waitForRoom";
import Modal from "../../Modal";
import SettingsStore from "../../settings/SettingsStore";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { ChooseServerChannelsDialog } from "../../components/views/dialogs/ChooseServerChannelsDialog";

vi.mock("./serverChannels", () => ({ listJoinableChannels: vi.fn(), joinChannels: vi.fn() }));
vi.mock("../room/waitForRoom", () => ({ waitForRoom: vi.fn() }));
vi.mock("../../Modal", () => ({ default: { createDialog: vi.fn() } }));
vi.mock("../../components/views/dialogs/ChooseServerChannelsDialog", () => ({ ChooseServerChannelsDialog: vi.fn() }));

const SPACE = "!space:x";
const client = {} as MatrixClient;

const channel = (roomId: string, kind: "text" | "voice" = "text", suggested = false): ServerChannel => ({
    roomId,
    name: roomId,
    kind,
    memberCount: 1,
    suggested,
    via: [],
});
const many = (count: number): ServerChannel[] =>
    Array.from({ length: count }, (_, index) => channel(`!c${index}`, index % 2 ? "voice" : "text"));

describe("defaultChannelSelection", () => {
    it("ticks every channel of a small server", () => {
        expect(defaultChannelSelection(many(JOIN_ALL_LIMIT)).size).toBe(JOIN_ALL_LIMIT);
    });

    it("ticks a large server's suggested channels", () => {
        const channels = [...many(11), channel("!pick", "text", true)];
        expect([...defaultChannelSelection(channels)]).toEqual(["!pick"]);
    });

    it("falls back to the first text and voice channel", () => {
        expect([...defaultChannelSelection(many(11))]).toEqual(["!c0", "!c1"]);
        expect([...defaultChannelSelection(Array.from({ length: 11 }, (_, i) => channel(`!t${i}`)))]).toEqual(["!t0"]);
    });
});

describe("server joining", () => {
    const space = {
        roomId: SPACE,
        isSpaceRoom: () => true,
        getMyMembership: () => KnownMembership.Join,
        currentState: { getStateEvents: () => ({}) },
    } as unknown as Room;
    let viewing: string | null;

    beforeEach(() => {
        viewing = SPACE;
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockImplementation(() => viewing);
        vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
        vi.mocked(waitForRoom).mockImplementation(async (_client, roomId, ready) =>
            roomId === SPACE && ready(space) ? space : ({ roomId } as Room),
        );
        vi.mocked(joinChannels).mockImplementation(async (_client, channels) => ({
            joined: channels.map((c) => c.roomId),
            failed: [],
        }));
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
    });
    afterEach(() => vi.restoreAllMocks());

    it("joins every channel of a small server and opens the first text channel", async () => {
        const channels = [channel("!voice", "voice"), channel("!general")];
        vi.mocked(listJoinableChannels).mockResolvedValue(channels);

        await onServerJoined(client, SPACE);

        expect(joinChannels).toHaveBeenCalledWith(client, channels);
        expect(Modal.createDialog).not.toHaveBeenCalled();
        expect(defaultDispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, room_id: "!general" }),
        );
    });

    it("asks which channels to join in a large server", async () => {
        const channels = many(JOIN_ALL_LIMIT + 1);
        vi.mocked(listJoinableChannels).mockResolvedValue(channels);
        await onServerJoined(client, SPACE);
        expect(joinChannels).not.toHaveBeenCalled();
        expect(Modal.createDialog).toHaveBeenCalledWith(ChooseServerChannelsDialog, { client, space, channels });
    });

    it("asks for a small server too when joining every channel is turned off", async () => {
        vi.mocked(SettingsStore.getValue).mockReturnValue(false);
        vi.mocked(listJoinableChannels).mockResolvedValue(many(2));
        await onServerJoined(client, SPACE);
        expect(joinChannels).not.toHaveBeenCalled();
        expect(Modal.createDialog).toHaveBeenCalled();
    });

    it("does nothing for a room that is not a server, a server without new channels, or a failed listing", async () => {
        vi.mocked(waitForRoom).mockResolvedValueOnce({ isSpaceRoom: () => false } as Room);
        await onServerJoined(client, SPACE);
        expect(listJoinableChannels).not.toHaveBeenCalled();

        vi.mocked(listJoinableChannels).mockResolvedValueOnce([]);
        await onServerJoined(client, SPACE);
        vi.mocked(listJoinableChannels).mockRejectedValueOnce(new Error("offline"));
        await onServerJoined(client, SPACE);
        expect(joinChannels).not.toHaveBeenCalled();
        expect(Modal.createDialog).not.toHaveBeenCalled();
    });

    it("does not pull the user away from somewhere else", async () => {
        viewing = "!elsewhere:x";
        await openFirstChannel(client, SPACE, [channel("!general")], ["!general"]);
        expect(defaultDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("opens nothing when no text channel was joined or it never arrives", async () => {
        await openFirstChannel(client, SPACE, [channel("!voice", "voice")], ["!voice"]);
        vi.mocked(waitForRoom).mockResolvedValueOnce(null);
        await openFirstChannel(client, SPACE, [channel("!general")], ["!general"]);
        expect(defaultDispatcher.dispatch).not.toHaveBeenCalled();
    });
});
