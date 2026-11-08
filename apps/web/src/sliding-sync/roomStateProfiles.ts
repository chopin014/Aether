/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * The room state each sliding sync request asks for, by what the room is used for.
 *
 * Every room on the account is listed with a small catalog of state, enough to draw it in the room list, the server
 * rail and a voice channel's occupancy. A room someone opens, joins a call in, or is about to open gets a
 * subscription with the state its views read: permissions, topic, pinned messages, Aether's own state and history.
 * Encrypted rooms load every state event, because sending needs the full membership. Spaces load their children and
 * the state of the server they represent, without history.
 */

import { EventType, M_BEACON_INFO, UNSTABLE_ELEMENT_FUNCTIONAL_USERS } from "matrix-js-sdk/src/matrix";
import {
    MSC3575_STATE_KEY_LAZY,
    MSC3575_STATE_KEY_ME,
    MSC3575_WILDCARD,
    type MSC3575RoomSubscription,
} from "matrix-js-sdk/src/sliding-sync";

import { JitsiCallMemberEventType } from "../call-types";
import { SOUNDBOARD_EVENT } from "../audio/soundboard/Soundboard";
import { SPACE_TAG_EVENT_TYPE } from "../profile/spaceTag";
import { VOICE_STATE_EVENT_TYPE } from "../utils/call/publishedVoiceState";
import { WIDGET_LAYOUT_EVENT_TYPE } from "../stores/widgets/types";

/** Room settings its admins choose for everyone, read by the room settings handler. */
const ROOM_SETTINGS_EVENT_TYPE = "im.vector.web.settings";
/** Whether a room shows link previews, read by the room settings handler. */
const URL_PREVIEWS_EVENT_TYPE = "org.matrix.room.preview_urls";
/** A bridge the room is part of, shown in the room's settings. */
const BRIDGE_EVENT_TYPE = "uk.half-shot.bridge";

/** Calls and widgets can outlive the recent timeline, so their current state is requested explicitly. */
export const CALL_STATE: string[][] = [
    [EventType.GroupCallPrefix, MSC3575_WILDCARD],
    [EventType.GroupCallMemberPrefix, MSC3575_WILDCARD],
    [EventType.RTCSlot, MSC3575_WILDCARD],
    ["im.vector.modular.widgets", MSC3575_WILDCARD],
    [JitsiCallMemberEventType, MSC3575_WILDCARD],
    // Who is muted or deafened in a voice channel, shown to people who have not joined it.
    [VOICE_STATE_EVENT_TYPE, MSC3575_WILDCARD],
];

/** State for every listed room: enough to show it in lists, in its Space and with its ongoing call. */
export const CATALOG_STATE: string[][] = [
    ...CALL_STATE,
    [EventType.RoomJoinRules, ""], // the public icon on the room list
    [EventType.RoomAvatar, ""], // any room avatar
    [EventType.RoomCanonicalAlias, ""], // for room name calculations
    [EventType.RoomTombstone, ""], // lets JS SDK hide rooms which are dead
    [EventType.RoomEncryption, ""], // lets rooms be configured for E2EE correctly
    [EventType.RoomCreate, ""], // for isSpaceRoom checks
    [EventType.SpaceChild, MSC3575_WILDCARD], // all space children
    [EventType.SpaceParent, MSC3575_WILDCARD], // all space parents
    [SPACE_TAG_EVENT_TYPE, ""], // a server's tag, shown on its members' profiles
    [EventType.RoomMember, MSC3575_STATE_KEY_ME], // lets the client calculate that we are in fact in the room
    [EventType.RoomMember, MSC3575_STATE_KEY_LAZY], // names and avatars for cached timeline senders
    // Who may notify everyone: without it, an @room mention neither highlights nor notifies in a listed room.
    [EventType.RoomPowerLevels, ""],
    // The rest is read for rooms nobody has opened, and only what is asked for arrives: the server sends no other
    // state, and the timeline never adds to it. A wildcard event type would bring every member of large rooms.
    [ROOM_SETTINGS_EVENT_TYPE, ""], // settings a room's admins choose for everyone in it
    [URL_PREVIEWS_EVENT_TYPE, ""], // whether the room shows link previews
    [UNSTABLE_ELEMENT_FUNCTIONAL_USERS.name, ""], // bots, left out of direct message names and call ringing
    [EventType.RoomThirdPartyInvite, MSC3575_WILDCARD], // invitations sent by email, which count as members
    [EventType.RoomPredecessor, ""], // the room this one replaced, when it is not named in its creation
    [WIDGET_LAYOUT_EVENT_TYPE, ""], // where the room's widgets sit, beside the widgets themselves
    [EventType.RoomPinnedEvents, ""], // pinned messages, such as a server notice's or one search filters on
    [EventType.RoomServerAcl, ""], // servers banned from the room, never used to route a link to it
    // The user's own live location shares, in both names a share may be sent under. This device keeps sending its
    // location to a share until the room's state says the share stopped, whether or not the room is open.
    ...M_BEACON_INFO.names.map((type) => [type, MSC3575_STATE_KEY_ME]),
];

/**
 * State for every Space the user is in, in the Spaces list: the catalog, and the Space's soundboard, which a voice
 * channel offers from every Space the user has joined, not only the one being looked at.
 */
export const SPACE_LIST_STATE: string[][] = [...CATALOG_STATE, [SOUNDBOARD_EVENT, MSC3575_WILDCARD]];

/**
 * State the room view, its header, composer and settings read, beyond the catalog. Without it, a room that was
 * first seen in a list would show no topic.
 */
const ROOM_VIEW_STATE: string[][] = [
    [EventType.RoomName, ""],
    [EventType.RoomTopic, ""],
    [EventType.RoomHistoryVisibility, ""],
    [EventType.RoomGuestAccess, ""],
    // A voice channel's soundboard, and the permission to add to it.
    [SOUNDBOARD_EVENT, MSC3575_WILDCARD],
    // The bridges a room is part of, shown in its settings.
    [BRIDGE_EVENT_TYPE, MSC3575_WILDCARD],
    // Everyone's live location shares, which the timeline shows live from the room's state.
    ...M_BEACON_INFO.names.map((type) => [type, MSC3575_WILDCARD]),
];

/** The catalog plus the state of an open room. */
export const ROOM_STATE: string[][] = [...CATALOG_STATE, ...ROOM_VIEW_STATE];

/** History loaded for a room someone has opened or is in a call in. */
export const OPEN_ROOM_TIMELINE_LIMIT = 50;

/** History loaded for a room someone is likely to open next, such as one they point at. */
export const PREFETCH_TIMELINE_LIMIT = 20;

/*
 * No subscription asks for include_old_rooms: simplified sliding sync (MSC4186) has no such option and Synapse
 * ignores it, while every request carries every subscription in full. An older version of an upgraded room is
 * opened like any other room.
 */

/** An unencrypted room someone has opened. Members are loaded lazily, as their senders appear. */
export const ROOM_SUBSCRIPTION: MSC3575RoomSubscription = {
    timeline_limit: OPEN_ROOM_TIMELINE_LIMIT,
    required_state: ROOM_STATE,
};

/** An unencrypted room someone is likely to open next: the same state, with a shorter history. */
export const PREFETCH_SUBSCRIPTION: MSC3575RoomSubscription = {
    ...ROOM_SUBSCRIPTION,
    timeline_limit: PREFETCH_TIMELINE_LIMIT,
};

/**
 * An encrypted room. Every state event is loaded, because messages are encrypted for every member's devices and
 * the SDK prepares that from the room's full membership.
 */
export const ENCRYPTED_SUBSCRIPTION: MSC3575RoomSubscription = {
    timeline_limit: OPEN_ROOM_TIMELINE_LIMIT,
    required_state: [[MSC3575_WILDCARD, MSC3575_WILDCARD]],
};

/**
 * A channel of the Space someone is looking at, before anyone opens it: what the room list shows of it, as a list
 * entry gets. Opening it moves it to its normal subscription.
 */
export const CHANNEL_SUBSCRIPTION: MSC3575RoomSubscription = {
    timeline_limit: 1,
    required_state: CATALOG_STATE,
};

/** A Space someone is looking at: its children, permissions and soundboard, without history. */
export const SPACE_SUBSCRIPTION: MSC3575RoomSubscription = {
    timeline_limit: 0,
    required_state: ROOM_STATE,
};

/**
 * A room whose state something outside the room view reads, such as an integration manager or a widget, and nobody
 * has open: what a list entry gets, without history. The state read is added to it.
 */
export const STATE_SUBSCRIPTION: MSC3575RoomSubscription = {
    timeline_limit: 0,
    required_state: CATALOG_STATE,
};

/**
 * A room nobody has seen yet, such as one opened from a link. It is fetched with the open-room state so it can be
 * drawn straight away, and moves to its normal subscription once its encryption is known.
 */
export const BOOTSTRAP_SUBSCRIPTION: MSC3575RoomSubscription = {
    timeline_limit: OPEN_ROOM_TIMELINE_LIMIT,
    required_state: ROOM_STATE,
};

/** A newly seen room whose recent history was only notices: one longer look back for conversation. */
export const EXPANDED_BOOTSTRAP_SUBSCRIPTION: MSC3575RoomSubscription = {
    ...BOOTSTRAP_SUBSCRIPTION,
    timeline_limit: 100,
};

/** The names the subscriptions above are registered under with the SDK. */
export enum RoomSubscriptionName {
    Room = "room",
    Prefetch = "prefetch",
    Encrypted = "encrypted",
    Space = "space",
    Channel = "channel",
    State = "state",
    Bootstrap = "bootstrap",
    ExpandedBootstrap = "bootstrap-expanded",
}

/** Every named subscription, for registering them with a new sliding sync connection. */
export const NAMED_SUBSCRIPTIONS: ReadonlyMap<RoomSubscriptionName, MSC3575RoomSubscription> = new Map([
    [RoomSubscriptionName.Room, ROOM_SUBSCRIPTION],
    [RoomSubscriptionName.Prefetch, PREFETCH_SUBSCRIPTION],
    [RoomSubscriptionName.Encrypted, ENCRYPTED_SUBSCRIPTION],
    [RoomSubscriptionName.Space, SPACE_SUBSCRIPTION],
    [RoomSubscriptionName.Channel, CHANNEL_SUBSCRIPTION],
    [RoomSubscriptionName.State, STATE_SUBSCRIPTION],
    [RoomSubscriptionName.Bootstrap, BOOTSTRAP_SUBSCRIPTION],
    [RoomSubscriptionName.ExpandedBootstrap, EXPANDED_BOOTSTRAP_SUBSCRIPTION],
]);
