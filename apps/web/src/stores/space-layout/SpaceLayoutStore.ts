/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    EventType,
    KnownMembership,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    RoomEvent,
    RoomStateEvent,
    type StateEvents,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";

import { type LayoutStateReader, roomStateReader, SPACE_LAYOUT_EVENT_TYPES } from "./SpaceLayout";

/**
 * Personal sidebar preferences for one server, in the Space's room account data so they follow the person to their
 * other devices without one server's change overwriting another's: `{ v: 1, hide_muted: boolean }`.
 */
export const SPACE_SIDEBAR_ACCOUNT_DATA_TYPE = "io.aether.space.sidebar";

export enum SpaceLayoutStoreEvent {
    /** Something a Space's channel layout depends on changed. Passes the Space's room id. */
    Changed = "changed",
}

type EventHandlerMap = { [SpaceLayoutStoreEvent.Changed]: (spaceId: string) => void };

/** An edit this client is sending, shown until the server's copy of that state arrives. */
interface Echo {
    content: Record<string, unknown>;
    /** Whether the server has accepted it, so that the next state event in its slot replaces it. */
    sent: boolean;
    /** The events that reached its slot while it was being sent, which may include ours and newer ones. */
    seen: Set<string>;
}

/** State event types that change how a Space's channels are laid out or who may edit that. */
const WATCHED_STATE = new Set<string>([...SPACE_LAYOUT_EVENT_TYPES, EventType.SpaceChild, EventType.RoomPowerLevels]);

const slot = (type: string, stateKey: string): string => `${type}\u0000${stateKey}`;

/**
 * Reads and writes the shared channel layout of servers, with the edits this client is still sending applied so that
 * a drag or a rename shows at once. The server stays the authority: its copy replaces an edit once it arrives, and
 * an edit it refuses is dropped.
 */
export class SpaceLayoutStore extends TypedEventEmitter<SpaceLayoutStoreEvent, EventHandlerMap> {
    private static internalInstance?: SpaceLayoutStore;

    public static get instance(): SpaceLayoutStore {
        SpaceLayoutStore.internalInstance ??= new SpaceLayoutStore();
        return SpaceLayoutStore.internalInstance;
    }

    private client?: MatrixClient;
    private readonly echoes = new Map<string, Map<string, Echo>>();
    private readonly hideMutedEchoes = new Map<string, boolean>();
    /** Which client the edits belong to, changing whenever another client takes over. */
    private generation = 0;

    /** Follow a client's state and account data. Safe to call again with the same client. */
    public watch(client: MatrixClient): void {
        if (this.client === client) return;
        // Requests still running for the previous client must leave the new client's edits alone.
        this.generation++;
        this.client?.off(RoomStateEvent.Events, this.onStateEvent);
        this.client?.off(RoomEvent.AccountData, this.onAccountData);
        this.echoes.clear();
        this.hideMutedEchoes.clear();
        this.client = client;
        client.on(RoomStateEvent.Events, this.onStateEvent);
        client.on(RoomEvent.AccountData, this.onAccountData);
    }

    /** The layout state of a Space, with the edits being sent applied. */
    public reader(space: Room): LayoutStateReader {
        const state = roomStateReader(space);
        const echoes = this.echoes.get(space.roomId);
        if (!echoes?.size) return state;
        return {
            get: (type, stateKey) => echoes.get(slot(type, stateKey))?.content ?? state.get(type, stateKey),
            keys: (type) => {
                const keys = new Set(state.keys(type));
                for (const key of echoes.keys()) {
                    const [echoType, stateKey] = key.split("\u0000");
                    if (echoType === type) keys.add(stateKey);
                }
                return [...keys];
            },
        };
    }

    /** Whether this user may change the Space's categories and channel placements. */
    public canEditLayout(space: Room): boolean {
        const userId = space.client.getSafeUserId();
        return (
            space.getMyMembership() === KnownMembership.Join &&
            SPACE_LAYOUT_EVENT_TYPES.every((type) => space.currentState.maySendStateEvent(type, userId))
        );
    }

    /**
     * Write one layout state event, showing it straight away.
     * @throws what the server returned when it refused the edit, after the edit has been undone on screen.
     */
    public async send(space: Room, type: string, stateKey: string, content: Record<string, unknown>): Promise<void> {
        const echoes = this.echoes.get(space.roomId) ?? new Map<string, Echo>();
        this.echoes.set(space.roomId, echoes);
        const key = slot(type, stateKey);
        const echo: Echo = { content, sent: false, seen: new Set() };
        echoes.set(key, echo);
        const generation = this.generation;
        this.emit(SpaceLayoutStoreEvent.Changed, space.roomId);

        try {
            const { event_id: eventId } = await space.client.sendStateEvent(
                space.roomId,
                type as keyof StateEvents,
                // The layout's readers validate every field, and keep the ones they don't know.
                content as StateEvents[keyof StateEvents],
                stateKey,
            );
            if (generation !== this.generation || echoes.get(key) !== echo) return;
            echo.sent = true;
            // The sync may have brought our event back before the request finished, and maybe a newer one after it.
            const current = space.currentState.getStateEvents(type, stateKey)?.getId();
            if (current === eventId || echo.seen.has(eventId)) this.dropEcho(space.roomId, key, echo);
        } catch (error) {
            if (generation === this.generation) this.dropEcho(space.roomId, key, echo);
            throw error;
        }
    }

    /** Whether the person hides the muted channels of this server. */
    public isHidingMutedChannels(space: Room): boolean {
        const echo = this.hideMutedEchoes.get(space.roomId);
        if (echo !== undefined) return echo;
        return space.getAccountData(SPACE_SIDEBAR_ACCOUNT_DATA_TYPE)?.getContent()?.hide_muted === true;
    }

    /** Hide or show the muted channels of this server, on every device of this person. */
    public async setHidingMutedChannels(space: Room, hide: boolean): Promise<void> {
        this.hideMutedEchoes.set(space.roomId, hide);
        this.emit(SpaceLayoutStoreEvent.Changed, space.roomId);
        const content = space.getAccountData(SPACE_SIDEBAR_ACCOUNT_DATA_TYPE)?.getContent() ?? {};
        try {
            await space.client.setRoomAccountData(space.roomId, SPACE_SIDEBAR_ACCOUNT_DATA_TYPE, {
                ...content,
                v: 1,
                hide_muted: hide,
            });
        } catch (error) {
            this.hideMutedEchoes.delete(space.roomId);
            this.emit(SpaceLayoutStoreEvent.Changed, space.roomId);
            throw error;
        }
    }

    /** Stop showing an edit, if it is still the one shown in its slot. */
    private dropEcho(spaceId: string, key: string, echo?: Echo): void {
        const echoes = this.echoes.get(spaceId);
        if (!echoes || (echo && echoes.get(key) !== echo)) return;
        echoes.delete(key);
        if (echoes.size === 0) this.echoes.delete(spaceId);
        this.emit(SpaceLayoutStoreEvent.Changed, spaceId);
    }

    private readonly onStateEvent = (event: MatrixEvent): void => {
        const type = event.getType();
        if (!WATCHED_STATE.has(type)) return;
        const spaceId = event.getRoomId()!;
        const key = slot(type, event.getStateKey()!);
        const echo = this.echoes.get(spaceId)?.get(key);
        // Once the server accepted our edit, whatever arrives next in its slot is at least as new.
        if (echo?.sent) {
            this.dropEcho(spaceId, key, echo);
            return;
        }
        // Before then, remember what arrived, to tell once the request finishes whether ours came and went.
        echo?.seen.add(event.getId()!);
        this.emit(SpaceLayoutStoreEvent.Changed, spaceId);
    };

    private readonly onAccountData = (event: MatrixEvent, room: Room): void => {
        if (event.getType() !== SPACE_SIDEBAR_ACCOUNT_DATA_TYPE) return;
        this.hideMutedEchoes.delete(room.roomId);
        this.emit(SpaceLayoutStoreEvent.Changed, room.roomId);
    };
}
