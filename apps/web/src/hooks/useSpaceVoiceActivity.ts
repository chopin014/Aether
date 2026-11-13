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

/** Whether two lists of voice activity show the same channels with the same people. */
function sameVoiceActivity(a: ServerVoiceActivityChannel[], b: ServerVoiceActivityChannel[]): boolean {
    return (
        a.length === b.length &&
        a.every((channel, i) => {
            const other = b[i];
            return (
                channel.roomId === other.roomId &&
                channel.name === other.name &&
                channel.people.length === other.people.length &&
                channel.people.every(
                    (person, j) =>
                        person.userId === other.people[j].userId &&
                        person.name === other.people[j].name &&
                        person.avatarUrl === other.people[j].avatarUrl,
                )
            );
        })
    );
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
        // The voice channels listed now, whose call ending changes the list.
        let listed = new Set<string>();
        const refresh = (): void => {
            // The store tells of every room that arrives or changes, such as while a new connection applies the
            // whole account, and the rail's tooltip is costly to draw again, so the same activity changes nothing.
            const next = getSpaceVoiceActivity(client, spaceStore, space);
            listed = new Set(next.map((channel) => channel.roomId));
            setChannels((current) => (sameVoiceActivity(current, next) ? current : next));
            // Follow the participants of every call, so joins and leaves update the tooltip while it is open.
            for (const roomId of spaceStore.getSpaceFilteredRoomIds(space.roomId)) {
                const call = CallStore.instance.getCall(roomId);
                if (call && !observed.has(call)) {
                    observed.add(call);
                    call.on(CallEvent.Participants, refresh);
                }
            }
        };
        // The call store tells of every room it looks at, such as each room arriving as sync applies the whole account,
        // most of them without a call. Such a room changes nothing, unless it is listed now and its call has ended;
        // reading the Space's rooms for each would work them out again for every room of a batch.
        const onCall = (call: Call | null, roomId: string): void => {
            if (call || listed.has(roomId)) refresh();
        };
        refresh();
        CallStore.instance.on(CallStoreEvent.Call, onCall);
        // The store names the Space in its event when the rooms in it change, such as once they first load.
        spaceStore.on(space.roomId, refresh);
        return () => {
            CallStore.instance.off(CallStoreEvent.Call, onCall);
            spaceStore.off(space.roomId, refresh);
            for (const call of observed) call.off(CallEvent.Participants, refresh);
        };
    }, [sdkContext, space]);
    return channels;
}
