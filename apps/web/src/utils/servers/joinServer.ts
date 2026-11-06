/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { EventType, KnownMembership, type MatrixClient } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import Modal from "../../Modal";
import SettingsStore from "../../settings/SettingsStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { ChooseServerChannelsDialog } from "../../components/views/dialogs/ChooseServerChannelsDialog";
import { waitForRoom } from "../room/waitForRoom";
import { joinChannels, listJoinableChannels, type ServerChannel } from "./serverChannels";

/** Servers with at most this many channels have them all joined at once, unless the user turned that off. */
export const JOIN_ALL_LIMIT = 10;

/**
 * The channels ticked when the picker opens: all of a small server's, otherwise the ones the server suggests, or
 * just its first text and voice channel when it suggests none.
 */
export function defaultChannelSelection(channels: ServerChannel[]): Set<string> {
    if (channels.length <= JOIN_ALL_LIMIT) return new Set(channels.map((channel) => channel.roomId));
    const suggested = channels.filter((channel) => channel.suggested);
    const picks = suggested.length
        ? suggested
        : [channels.find((channel) => channel.kind === "text"), channels.find((channel) => channel.kind === "voice")];
    return new Set(picks.filter((channel) => !!channel).map((channel) => channel.roomId));
}

/**
 * Open the first text channel that was just joined, but only while the user is still looking at the server itself:
 * joining runs in the background and must not pull them away from somewhere they went meanwhile.
 */
export async function openFirstChannel(
    client: MatrixClient,
    spaceId: string,
    channels: ServerChannel[],
    joined: string[],
): Promise<void> {
    const first = channels.find((channel) => channel.kind === "text" && joined.includes(channel.roomId));
    if (!first) return;
    const room = await waitForRoom(
        client,
        first.roomId,
        (candidate) => candidate.getMyMembership() === KnownMembership.Join,
        15_000,
    );
    if (!room || SDKContextClass.instance.roomViewStore.getRoomId() !== spaceId) return;
    defaultDispatcher.dispatch<ViewRoomPayload>({
        action: Action.ViewRoom,
        room_id: first.roomId,
        metricsTrigger: undefined,
    });
}

/**
 * After the user joins a server, join its channels as Discord does: every channel of a small server straight away,
 * or a picker for a large one. Joining a room that turns out not to be a server does nothing.
 */
export async function onServerJoined(client: MatrixClient, spaceId: string): Promise<void> {
    const space = await waitForRoom(
        client,
        spaceId,
        (room) =>
            room.getMyMembership() === KnownMembership.Join &&
            !!room.currentState.getStateEvents(EventType.RoomCreate, ""),
    );
    if (!space?.isSpaceRoom()) return;

    let channels: ServerChannel[];
    try {
        channels = await listJoinableChannels(client, spaceId);
    } catch (error) {
        logger.warn("Could not list the channels of a joined server", error);
        return;
    }
    if (channels.length === 0) return;

    if (channels.length <= JOIN_ALL_LIMIT && SettingsStore.getValue("Spaces.joinAllChannels")) {
        const { joined } = await joinChannels(client, channels);
        await openFirstChannel(client, spaceId, channels, joined);
        return;
    }
    Modal.createDialog(ChooseServerChannelsDialog, { client, space, channels });
}
