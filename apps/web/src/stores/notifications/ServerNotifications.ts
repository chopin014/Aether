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
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { getRoomNotifsState, RoomNotifState } from "../../RoomNotifs";
import { clearRoomNotification } from "../../utils/notifications";
import { EchoChamber } from "../local-echo/EchoChamber";
import { getLayoutChildren } from "../space-layout/SpaceLayout";
import { TimedMutes } from "./TimedMutes";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ActionPayload } from "../../dispatcher/payloads";

/**
 * A person's notification settings for a whole server, in the Space's room account data:
 * `{ v: 1, level?, muted?: { until? }, muted_categories?: { [categoryId]: { until? } } }`. Matrix has no server-wide
 * settings, so the level is applied to each channel that follows the server, and a server or category mute mutes its
 * channels; these records say what the person chose, apart from which channels happen to be muted.
 */
export const SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE = "io.aether.space.notifications";

/** How a server's channels notify: about every message, or only mentions, as Discord offers. */
export type ServerNotificationLevel = "all" | "mentions";

/** A mute the person chose for a server or a category; `until` is absent while it lasts until turned off. */
export interface OwnedMute {
    until?: number;
}

const LEVEL_STATES: Record<ServerNotificationLevel, RoomNotifState> = {
    all: RoomNotifState.AllMessages,
    mentions: RoomNotifState.MentionsOnly,
};

/** The server's channels the person has joined. Nested servers keep their own settings. */
export function serverChannels(space: Room): Room[] {
    return getLayoutChildren(space)
        .map((child) => space.client.getRoom(child.roomId))
        .filter(
            (room): room is Room => !!room && !room.isSpaceRoom() && room.getMyMembership() === KnownMembership.Join,
        );
}

/** Settings this client wrote for each Space, until the sync brings them back. */
const writtenSettings = new Map<string, Record<string, unknown>>();
/** The last settings write queued for each Space, so that each one builds on the one before. */
const settingsQueues = new Map<string, Promise<unknown>>();

function settings(space: Room): Record<string, unknown> {
    return (
        writtenSettings.get(space.roomId) ??
        space.getAccountData(SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE)?.getContent() ??
        {}
    );
}

/**
 * Change the person's settings for a server. Changes run one after another, each on top of the last one written, so
 * that muting two categories at once, or muting while changing the level, keeps both.
 */
function saveSettings(
    space: Room,
    change: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
    const previous = settingsQueues.get(space.roomId) ?? Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(async () => {
            const content: Record<string, unknown> = { ...change(settings(space)), v: 1 };
            for (const [key, value] of Object.entries(content)) if (value === undefined) delete content[key];
            await space.client.setRoomAccountData(space.roomId, SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, content);
            writtenSettings.set(space.roomId, content);
        });
    settingsQueues.set(space.roomId, next);
    void next
        .catch(() => {})
        .finally(() => {
            if (settingsQueues.get(space.roomId) === next) settingsQueues.delete(space.roomId);
        });
    return next;
}

/** Forget what this client wrote for a Space once the sync brings its settings back. */
function onSettingsSynced(space: Room): void {
    writtenSettings.delete(space.roomId);
}

/**
 * A mute the person chose, if it is still on. One whose time has passed still counts while some of its channels are
 * muted by it, until those are back on, so the person can always turn it off.
 */
function ownedMute(value: unknown, stillMuting: () => boolean): OwnedMute | undefined {
    if (!value || typeof value !== "object") return undefined;
    const until = (value as Record<string, unknown>).until;
    if (until === undefined) return {};
    if (typeof until === "number" && until > Date.now()) return { until };
    return stillMuting() ? {} : undefined;
}

/** The mute the person chose for the server, if one is on. Channels muted one by one don't count. */
export function getServerMute(space: Room): OwnedMute | undefined {
    return ownedMute(settings(space).muted, () =>
        serverChannels(space).some((room) => TimedMutes.instance.mutedBy(room) === "server"),
    );
}

function mutedCategories(current: Record<string, unknown>): Record<string, unknown> {
    const categories = current.muted_categories;
    return categories && typeof categories === "object" ? { ...(categories as Record<string, unknown>) } : {};
}

/** The mute the person chose for one of the server's categories, if one is on. */
export function getCategoryMute(space: Room, categoryId: string, channels: Room[] = []): OwnedMute | undefined {
    return ownedMute(mutedCategories(settings(space))[categoryId], () =>
        channels.some((room) => TimedMutes.instance.mutedBy(room) === "category"),
    );
}

const untilOf = (duration: number | null): OwnedMute => (duration === null ? {} : { until: Date.now() + duration });

/** Mute every channel of the server, for `duration` milliseconds or until turned back on. */
export async function muteServer(space: Room, duration: number | null): Promise<void> {
    await saveSettings(space, (current) => ({ ...current, muted: untilOf(duration) }));
    await TimedMutes.instance.mute(serverChannels(space), duration, "server");
}

/**
 * Turn the server back on; channels muted on their own or by their category stay muted. The server stays muted in the
 * person's settings until its channels are back on, so a failure leaves the way to try again.
 */
export async function unmuteServer(space: Room): Promise<void> {
    await TimedMutes.instance.unmute(serverChannels(space), "server");
    await saveSettings(space, (current) => ({ ...current, muted: undefined }));
}

/** Mute the channels of one of the server's categories. */
export async function muteCategory(
    space: Room,
    categoryId: string,
    channels: Room[],
    duration: number | null,
): Promise<void> {
    await saveSettings(space, (current) => ({
        ...current,
        muted_categories: { ...mutedCategories(current), [categoryId]: untilOf(duration) },
    }));
    await TimedMutes.instance.mute(channels, duration, "category");
}

/** Turn a category back on; channels muted on their own or by the server stay muted. */
export async function unmuteCategory(space: Room, categoryId: string, channels: Room[]): Promise<void> {
    await TimedMutes.instance.unmute(channels, "category");
    await saveSettings(space, (current) => {
        const categories = mutedCategories(current);
        delete categories[categoryId];
        return { ...current, muted_categories: categories };
    });
}

/** Mark every channel of the server as read. */
export async function markServerAsRead(space: Room): Promise<void> {
    await Promise.all(serverChannels(space).map((room) => clearRoomNotification(room, room.client)));
}

/** The person's notification level for the server. */
export function getServerNotificationLevel(space: Room): ServerNotificationLevel {
    return settings(space).level === "mentions" ? "mentions" : "all";
}

/**
 * Set how the server's channels notify. Channels following the server's previous level move to the new one; channels
 * with a level of their own, and muted ones, keep theirs, as channel settings override the server's in Discord.
 */
export async function setServerNotificationLevel(space: Room, level: ServerNotificationLevel): Promise<void> {
    const previous = LEVEL_STATES[getServerNotificationLevel(space)];
    const next = LEVEL_STATES[level];
    for (const room of serverChannels(space)) {
        const current = getRoomNotifsState(room.client, room.roomId) ?? RoomNotifState.AllMessages;
        if (current === previous && current !== next) EchoChamber.forRoom(room).notificationVolume = next;
    }
    await saveSettings(space, (current) => ({ ...current, level }));
}

/**
 * Gives a channel that joins a server after the person chose the server's level that level, as if it had been there
 * all along. The channel can reach the client before the server lists it, or the other way round, so both are
 * watched.
 */
export class ServerNotificationDefaults {
    private static internalInstance?: ServerNotificationDefaults;

    public static get instance(): ServerNotificationDefaults {
        ServerNotificationDefaults.internalInstance ??= new ServerNotificationDefaults();
        return ServerNotificationDefaults.internalInstance;
    }

    private client?: MatrixClient;
    private dispatcherRef?: string;

    /** Follow a client's joins and servers. Safe to call again with the same client. */
    public watch(client: MatrixClient): void {
        if (this.client === client) return;
        this.stop();
        this.client = client;
        client.on(RoomEvent.MyMembership, this.onMembership);
        client.on(RoomStateEvent.Events, this.onStateEvent);
        client.on(RoomEvent.AccountData, this.onAccountData);
        this.dispatcherRef = defaultDispatcher.register(this.onAction);
    }

    /** Stop following the client. */
    public stop(): void {
        this.client?.off(RoomEvent.MyMembership, this.onMembership);
        this.client?.off(RoomStateEvent.Events, this.onStateEvent);
        this.client?.off(RoomEvent.AccountData, this.onAccountData);
        this.client = undefined;
        writtenSettings.clear();
        settingsQueues.clear();
        if (this.dispatcherRef) defaultDispatcher.unregister(this.dispatcherRef);
        this.dispatcherRef = undefined;
    }

    /** Give a channel its server's level, if it follows a server with one and still has the default. */
    private apply(room: Room, space?: Room): void {
        if (room.isSpaceRoom() || room.getMyMembership() !== KnownMembership.Join) return;
        const server =
            space ??
            room.client
                .getRooms()
                .find(
                    (candidate) =>
                        candidate.isSpaceRoom() &&
                        getServerNotificationLevel(candidate) !== "all" &&
                        getLayoutChildren(candidate).some((child) => child.roomId === room.roomId),
                );
        if (!server || getServerNotificationLevel(server) === "all") return;
        // Only a channel still at the default follows the server; one with a level of its own keeps it.
        const current = getRoomNotifsState(room.client, room.roomId) ?? RoomNotifState.AllMessages;
        if (current !== RoomNotifState.AllMessages) return;
        try {
            EchoChamber.forRoom(room).notificationVolume = LEVEL_STATES[getServerNotificationLevel(server)];
        } catch (error) {
            logger.warn("Failed to apply a server's notification level to a new channel", error);
        }
    }

    private readonly onMembership = (room: Room, membership: string, previous?: string): void => {
        if (membership === KnownMembership.Join && previous !== KnownMembership.Join) this.apply(room);
    };

    /** A server listing a channel the person is already in, for the first time. */
    private readonly onStateEvent = (event: MatrixEvent): void => {
        if (event.getType() !== EventType.SpaceChild || event.getPrevContent()?.via) return;
        const space = this.client?.getRoom(event.getRoomId());
        const room = this.client?.getRoom(event.getStateKey());
        if (space && room && getLayoutChildren(space).some((child) => child.roomId === room.roomId)) {
            this.apply(room, space);
        }
    };

    private readonly onAccountData = (event: MatrixEvent, room: Room): void => {
        if (event.getType() === SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE) onSettingsSynced(room);
    };

    private readonly onAction = (payload: ActionPayload): void => {
        if (payload.action === Action.OnLoggedOut) this.stop();
    };
}
