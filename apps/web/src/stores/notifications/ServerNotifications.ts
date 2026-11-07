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

import { RoomNotifState } from "../../RoomNotifs";
import { clearRoomNotification } from "../../utils/notifications";
import { getLayoutChildren } from "../space-layout/SpaceLayout";
import { StoppedError, TimedMutes } from "./TimedMutes";
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

/** The last operation queued for each Space, so that each one starts after the one before has finished. */
const spaceQueues = new Map<string, Promise<unknown>>();

function settings(space: Room): Record<string, unknown> {
    return space.getAccountData(SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE)?.getContent() ?? {};
}

/** Stop if the person logged out, or another client took over, since `generation` was read. */
function checkGeneration(generation: number): void {
    if (generation !== TimedMutes.instance.currentGeneration) throw new StoppedError();
}

/**
 * Run an operation on a server's notifications, its settings and its channels together, after the ones queued before
 * it have finished. Muting and unmuting the server, or one of its categories, at the same moment therefore can't leave
 * the channels and the person's settings disagreeing.
 */
function inSpaceOrder(space: Room, operation: (generation: number) => Promise<void>): Promise<void> {
    const generation = TimedMutes.instance.currentGeneration;
    const previous = spaceQueues.get(space.roomId) ?? Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(() => {
            checkGeneration(generation);
            // Whoever waits stops waiting at logout, even while a request of the operation is on its way.
            return Promise.race([operation(generation), TimedMutes.instance.untilStopped]);
        });
    spaceQueues.set(space.roomId, next);
    void next
        .catch(() => {})
        .finally(() => {
            if (spaceQueues.get(space.roomId) === next) spaceQueues.delete(space.roomId);
        });
    return next;
}

/** The person's settings for a server as the server holds them, including what the operations before wrote. */
function fetchSettings(space: Room, generation: number): Promise<Record<string, unknown>> {
    return TimedMutes.instance.readAccountData(space, SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, generation);
}

/**
 * Change the person's settings for a server, starting from {@link fetchSettings} so that the change keeps what the
 * operations before wrote, even before the sync brings it back.
 */
async function writeSettings(
    space: Room,
    generation: number,
    change: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
    const content: Record<string, unknown> = { ...change(await fetchSettings(space, generation)), v: 1 };
    for (const [key, value] of Object.entries(content)) if (value === undefined) delete content[key];
    await TimedMutes.instance.writeAccountData(space, SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, content, generation);
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
export function muteServer(space: Room, duration: number | null): Promise<void> {
    return inSpaceOrder(space, async (generation) => {
        await writeSettings(space, generation, (current) => ({ ...current, muted: untilOf(duration) }));
        await TimedMutes.instance.mute(serverChannels(space), duration, "server");
    });
}

/**
 * Turn the server back on; channels muted on their own or by their category stay muted. The server stays muted in the
 * person's settings until its channels are back on, so a failure leaves the way to try again.
 */
export function unmuteServer(space: Room): Promise<void> {
    return inSpaceOrder(space, async (generation) => {
        await TimedMutes.instance.unmute(serverChannels(space), "server");
        await writeSettings(space, generation, (current) => ({ ...current, muted: undefined }));
    });
}

/** Mute the channels of one of the server's categories. */
export function muteCategory(
    space: Room,
    categoryId: string,
    channels: Room[],
    duration: number | null,
): Promise<void> {
    return inSpaceOrder(space, async (generation) => {
        await writeSettings(space, generation, (current) => ({
            ...current,
            muted_categories: { ...mutedCategories(current), [categoryId]: untilOf(duration) },
        }));
        await TimedMutes.instance.mute(channels, duration, "category");
    });
}

/** Turn a category back on; channels muted on their own or by the server stay muted. */
export function unmuteCategory(space: Room, categoryId: string, channels: Room[]): Promise<void> {
    return inSpaceOrder(space, async (generation) => {
        await TimedMutes.instance.unmute(channels, "category");
        await writeSettings(space, generation, (current) => {
            const categories = mutedCategories(current);
            delete categories[categoryId];
            return { ...current, muted_categories: categories };
        });
    });
}

/** Mark every channel of the server as read. */
export async function markServerAsRead(space: Room): Promise<void> {
    await Promise.all(serverChannels(space).map((room) => clearRoomNotification(room, room.client)));
}

const levelOf = (current: Record<string, unknown>): ServerNotificationLevel =>
    current.level === "mentions" ? "mentions" : "all";

/** The person's notification level for the server. */
export function getServerNotificationLevel(space: Room): ServerNotificationLevel {
    return levelOf(settings(space));
}

/**
 * Set how the server's channels notify. Channels following the server's previous level move to the new one; channels
 * with a level of their own, and muted ones, keep theirs, as channel settings override the server's in Discord.
 */
export function setServerNotificationLevel(space: Room, level: ServerNotificationLevel): Promise<void> {
    return inSpaceOrder(space, async (generation) => {
        const previous = LEVEL_STATES[levelOf(await fetchSettings(space, generation))];
        await TimedMutes.instance.moveLevel(serverChannels(space), previous, LEVEL_STATES[level]);
        await writeSettings(space, generation, (current) => ({ ...current, level }));
    });
}

/**
 * Gives a channel that joins a server after the person chose the server's level that level, as if it had been there
 * all along. The channel can reach the client before the server lists it, or the other way round, so both are
 * watched. This waits for the server's operations queued before it, and reads the level the last of them left.
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
        this.dispatcherRef = defaultDispatcher.register(this.onAction);
    }

    /** Stop following the client. */
    public stop(): void {
        this.client?.off(RoomEvent.MyMembership, this.onMembership);
        this.client?.off(RoomStateEvent.Events, this.onStateEvent);
        this.client = undefined;
        spaceQueues.clear();
        if (this.dispatcherRef) defaultDispatcher.unregister(this.dispatcherRef);
        this.dispatcherRef = undefined;
    }

    /** Give a channel its servers' level, if it follows one with a level and still has the default. */
    private apply(room: Room, space?: Room): void {
        if (room.isSpaceRoom() || room.getMyMembership() !== KnownMembership.Join) return;
        // A server's level may be changing right now, so every server listing the channel is asked, each in its turn.
        const servers = space
            ? [space]
            : room.client
                  .getRooms()
                  .filter(
                      (candidate) =>
                          candidate.isSpaceRoom() &&
                          getLayoutChildren(candidate).some((child) => child.roomId === room.roomId),
                  );
        for (const server of servers) {
            // The synced level may not show a change this client just made, so the level is read when its turn comes.
            inSpaceOrder(server, async (generation) => {
                const level = levelOf(await fetchSettings(server, generation));
                if (level === "all") return;
                // Only a channel still at the default follows the server; one with a level of its own keeps it.
                await TimedMutes.instance.moveLevel([room], RoomNotifState.AllMessages, LEVEL_STATES[level]);
            }).catch((error) => {
                if (error instanceof StoppedError) return;
                logger.warn("Failed to apply a server's notification level to a new channel", error);
            });
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

    private readonly onAction = (payload: ActionPayload): void => {
        if (payload.action === Action.OnLoggedOut) this.stop();
    };
}
