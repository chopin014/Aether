/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect, useState } from "react";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { type ServerVoiceActivityChannel } from "@element-hq/web-shared-components";

import { CallStore, CallStoreEvent } from "../stores/CallStore";
import { type Call, CallEvent } from "../models/Call";
import type SpaceStore from "../stores/spaces/SpaceStore";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import { isVideoRoom } from "../utils/video-rooms";
import { mediaFromMxc } from "../customisations/Media";

/** The voice channels of a Space that have people in them, each with those people, ordered by name. */
export function getSpaceVoiceActivity(
    client: MatrixClient,
    spaceStore: SpaceStore,
    space: Room,
): ServerVoiceActivityChannel[] {
    return [...spaceStore.getSpaceFilteredRoomIds(space.roomId)]
        .map((roomId) => client.getRoom(roomId))
        .filter((room): room is Room => !!room && isVideoRoom(room))
        .map((room) => ({
            roomId: room.roomId,
            name: room.name,
            people: [...(CallStore.instance.getCall(room.roomId)?.participants.keys() ?? [])]
                .map((member) => {
                    const mxc = member.getMxcAvatarUrl();
                    return {
                        userId: member.userId,
                        name: member.name,
                        avatarUrl: mxc
                            ? (mediaFromMxc(mxc, client).getSquareThumbnailHttp(48) ?? undefined)
                            : undefined,
                    };
                })
                .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .filter((channel) => channel.people.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Who is in a Space's voice channels, kept current as calls start and end, people join or leave them, and channels
 * are added to the Space or removed from it. Pass no Space to skip the work, such as for a rail item that is not a
 * Space.
 */
export function useSpaceVoiceActivity(sdkContext: SDKContextClass, space?: Room): ServerVoiceActivityChannel[] {
    const [channels, setChannels] = useState<ServerVoiceActivityChannel[]>([]);
    useEffect(() => {
        const client = space && sdkContext.client;
        if (!client || !space) {
            setChannels([]);
            return;
        }
        const spaceStore = sdkContext.spaceStore;
        const observed = new Set<Call>();
        const refresh = (): void => {
            setChannels(getSpaceVoiceActivity(client, spaceStore, space));
            // Follow the participants of every call, so joins and leaves update the tooltip while it is open.
            for (const roomId of spaceStore.getSpaceFilteredRoomIds(space.roomId)) {
                const call = CallStore.instance.getCall(roomId);
                if (call && !observed.has(call)) {
                    observed.add(call);
                    call.on(CallEvent.Participants, refresh);
                }
            }
        };
        refresh();
        CallStore.instance.on(CallStoreEvent.Call, refresh);
        // The store names the Space in its event when the rooms in it change, such as once they first load.
        spaceStore.on(space.roomId, refresh);
        return () => {
            CallStore.instance.off(CallStoreEvent.Call, refresh);
            spaceStore.off(space.roomId, refresh);
            for (const call of observed) call.off(CallEvent.Participants, refresh);
        };
    }, [sdkContext, space]);
    return channels;
}
