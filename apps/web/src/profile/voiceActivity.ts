/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useSyncExternalStore } from "react";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { type DesktopProfileActivity } from "@element-hq/web-shared-components";

import { CallStore, CallStoreEvent } from "../stores/CallStore";
import { type Call, CallEvent } from "../models/Call";
import { mediaFromMxc } from "../customisations/Media";
import { SDKContextClass } from "../contexts/SDKContextClass";

/** How many faces the activity card shows before it only counts. */
const MAX_FACES = 5;

/**
 * Which voice channel each person is in, from the MatrixRTC calls this client already follows. One index serves every
 * member row and profile card, so a long member list does not each watch every call.
 */
export class VoiceActivityIndex {
    private static current?: VoiceActivityIndex;

    /** The shared index, watching calls from the first time it is asked for. */
    public static get instance(): VoiceActivityIndex {
        VoiceActivityIndex.current ??= new VoiceActivityIndex(CallStore.instance);
        return VoiceActivityIndex.current;
    }

    private rooms = new Map<string, string>();
    private readonly listeners = new Set<() => void>();
    private readonly watched = new Map<Call, () => void>();

    public constructor(private readonly store: CallStore) {
        store.on(CallStoreEvent.Call, this.onCall);
        this.rebuild();
    }

    /** The voice channel a person is in, if any. */
    public roomOf(userId: string): string | undefined {
        return this.rooms.get(userId);
    }

    /** Be told when anyone joins or leaves a voice channel. */
    public subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    /** Stop watching calls. */
    public dispose(): void {
        this.store.off(CallStoreEvent.Call, this.onCall);
        for (const [call, listener] of this.watched) call.off(CallEvent.Participants, listener);
        this.watched.clear();
        this.listeners.clear();
        if (VoiceActivityIndex.current === this) VoiceActivityIndex.current = undefined;
    }

    private readonly onCall = (): void => this.rebuild();

    private rebuild(): void {
        const calls = new Set(this.store.getAllCalls().values());
        for (const [call, listener] of this.watched) {
            if (calls.has(call)) continue;
            call.off(CallEvent.Participants, listener);
            this.watched.delete(call);
        }
        for (const call of calls) {
            if (this.watched.has(call)) continue;
            const listener = (): void => this.rebuild();
            call.on(CallEvent.Participants, listener);
            this.watched.set(call, listener);
        }
        const rooms = new Map<string, string>();
        for (const call of calls) {
            for (const member of call.participants.keys()) rooms.set(member.userId, call.roomId);
        }
        const changed =
            rooms.size !== this.rooms.size || [...rooms].some(([user, room]) => this.rooms.get(user) !== room);
        this.rooms = rooms;
        if (changed) for (const listener of this.listeners) listener();
    }
}

/** The voice channel a person is in, kept current as people join and leave calls. */
export function useVoiceRoom(userId: string | undefined): string | undefined {
    return useSyncExternalStore(
        VoiceActivityIndex.instance.subscribe,
        () => (userId ? VoiceActivityIndex.instance.roomOf(userId) : undefined),
        () => undefined,
    );
}

/** What a profile card shows about a person in a voice channel: where, and who is there with them. */
export function voiceActivity(client: MatrixClient, roomId: string | undefined): DesktopProfileActivity | undefined {
    if (!roomId) return undefined;
    const room = client.getRoom(roomId);
    const call = CallStore.instance.getCall(roomId);
    if (!room || !call) return undefined;
    const people = [...call.participants.keys()];
    const space = SDKContextClass.instance.spaceStore.getParents(roomId)[0];
    return {
        kind: "voice",
        roomId,
        channelName: room.name,
        spaceName: space?.name,
        count: people.length,
        people: people.slice(0, MAX_FACES).map((member) => {
            const mxc = member.getMxcAvatarUrl();
            return {
                id: member.userId,
                name: member.name,
                avatarUrl: mxc ? (mediaFromMxc(mxc).getThumbnailOfSourceHttp(48, 48, "crop") ?? undefined) : undefined,
            };
        }),
    };
}
