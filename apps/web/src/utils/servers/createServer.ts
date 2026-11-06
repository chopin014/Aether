/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { JoinRule, KnownMembership, type MatrixClient, Preset, RoomType } from "matrix-js-sdk/src/matrix";

import createRoom, { type IOpts } from "../../createRoom";
import { createSpace } from "../../components/views/spaces/SpaceCreateMenu";
import { _t } from "../../languageHandler";
import { privateShouldBeEncrypted } from "../rooms";
import { waitForRoom } from "../room/waitForRoom";

/** Who a new server is for: friends join by invite, a community is open to anyone with the link. */
export type ServerAudience = "friends" | "community";

/** What the user chose for a new server. */
export interface CreateServerOptions {
    name: string;
    audience: ServerAudience;
    avatar?: File;
}

/** The rooms making up a newly created server. */
export interface CreatedServer {
    spaceId: string;
    textChannelId: string;
    voiceChannelId: string;
}

/** The step a server creation has reached, for progress messages. */
export type CreateServerStep = "server" | "channels";

/**
 * Create a server the way Discord does: a space holding one text channel and one voice channel, ready to talk in.
 * A community server and its channels are public; a friends server is invite only and its channels are open to
 * the server's members.
 */
export async function createServer(
    client: MatrixClient,
    { name, audience, avatar }: CreateServerOptions,
    onStep?: (step: CreateServerStep) => void,
): Promise<CreatedServer> {
    const isPublic = audience === "community";

    onStep?.("server");
    // No address is reserved: a taken one would fail creation, and the server's link works without it.
    const spaceId = await createSpace(client, name, isPublic, undefined, undefined, avatar, {}, { andView: false });
    if (!spaceId) throw new Error("The server was not created");
    // Channels name their space as parent, so it has to be known locally first.
    const space = await waitForRoom(client, spaceId, (room) => room.isSpaceRoom());
    if (!space) throw new Error("The new server did not arrive from the homeserver");

    onStep?.("channels");
    const channel: IOpts = {
        parentSpace: space,
        suggested: true,
        spinner: false,
        inlineErrors: true,
        andView: false,
        joinRule: isPublic ? undefined : JoinRule.Restricted,
        encryption: !isPublic && privateShouldBeEncrypted(client),
        createOpts: { preset: isPublic ? Preset.PublicChat : Preset.PrivateChat },
    };
    const [textChannelId, voiceChannelId] = await Promise.all([
        createRoom(client, { ...channel, name: _t("desktop|create_server|text_channel_name") }),
        createRoom(client, {
            ...channel,
            name: _t("desktop|create_server|voice_channel_name"),
            roomType: RoomType.UnstableCall,
        }),
    ]);
    if (!textChannelId || !voiceChannelId) throw new Error("The server's channels were not created");

    await waitForRoom(client, textChannelId, (room) => room.getMyMembership() === KnownMembership.Join);
    return { spaceId, textChannelId, voiceChannelId };
}
