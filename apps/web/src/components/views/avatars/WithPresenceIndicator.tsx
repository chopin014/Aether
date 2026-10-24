/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useEffect, useState } from "react";
import {
    ClientEvent,
    type Room,
    type MatrixEvent,
    type RoomMember,
    RoomStateEvent,
    type User,
    UserEvent,
} from "matrix-js-sdk/src/matrix";

import { getKnownPresence } from "../../../utils/knownPresence";
import { isPresenceEnabled } from "../../../utils/presence";
import DMRoomMap from "../../../utils/DMRoomMap";
import { getJoinedNonFunctionalMembers } from "../../../utils/room/getJoinedNonFunctionalMembers";
import { useEventEmitter } from "../../../hooks/useEventEmitter";
import { useFeatureEnabled } from "../../../hooks/useSettings";
import { useMergedPresence } from "../../../presence/useMergedPresence";
import { type MergedPresenceState } from "../../../presence/mergedPresence";
import { BUSY_PRESENCE_NAME } from "../rooms/PresenceLabel";
import AvatarPresenceIconView from "../rooms/MemberList/tiles/common/PresenceIconView";

interface Props {
    room: Room;
    children: ReactNode;
}

export enum Presence {
    // This class used to have its own presence indicator and has been
    // updated to use the new one so presence colours / icons match across the app.
    // These values are the ones from the wire that PresenceIconView expects,
    // but really some of the logic here could be deduplicated.
    Online = "online",
    Away = "unavailable",
    Offline = "offline",
    Busy = "busy",
}

function getDmMember(room: Room): RoomMember | null {
    const otherUserId = DMRoomMap.shared().getUserIdForRoomId(room.roomId);
    return otherUserId ? room.getMember(otherUserId) : null;
}

export const useDmMember = (room?: Room): RoomMember | null => {
    const [dmMember, setDmMember] = useState<RoomMember | null>(room ? getDmMember(room) : null);
    const updateDmMember = (): void => {
        setDmMember(room ? getDmMember(room) : null);
    };

    useEventEmitter(room?.currentState, RoomStateEvent.Members, updateDmMember);
    useEventEmitter(room?.client, ClientEvent.AccountData, updateDmMember);
    useEffect(updateDmMember, [room]);

    return dmMember;
};

function getPresenceFromUser(user: User | null | undefined): Presence | null {
    if (!user) return null;

    const presence = getKnownPresence(user);
    if (!presence) return null;
    const isOnline = presence === "online";
    if (BUSY_PRESENCE_NAME.matches(presence)) {
        return Presence.Busy;
    }
    if (isOnline) {
        return Presence.Online;
    }
    if (presence === "offline") {
        return Presence.Offline;
    }
    if (presence === "unavailable") {
        return Presence.Away;
    }

    return null;
}

function getPresence(room: Room, member: RoomMember | null): Presence | null {
    // Fall back to client.getUser() when member.user is not yet linked during initial sync
    const user = member?.user ?? (member ? room.client.getUser(member.userId) : null);
    return getPresenceFromUser(user);
}

const useServerPresence = (room: Room, member: RoomMember | null): Presence | null => {
    const [presence, setPresence] = useState<Presence | null>(getPresence(room, member));
    const updatePresence = (): void => {
        setPresence(getPresence(room, member));
    };

    useEventEmitter(member?.user, UserEvent.Presence, updatePresence);
    useEventEmitter(member?.user, UserEvent.LastPresenceTs, updatePresence);
    // Also listen at client level to catch presence events when member.user is not yet linked
    useEventEmitter(room.client, UserEvent.Presence, (_event: unknown, user: User) => {
        if (user?.userId === member?.userId) updatePresence();
    });
    useEventEmitter(room.client, UserEvent.LastPresenceTs, (_event: unknown, user: User) => {
        if (user?.userId === member?.userId) updatePresence();
    });
    useEventEmitter(room.client, ClientEvent.Event, (event: MatrixEvent) => {
        if (event.getType() === "m.presence" && event.getSender() === member?.userId) updatePresence();
    });
    useEffect(updatePresence, [room, member]);

    if (getJoinedNonFunctionalMembers(room).length !== 2 || !isPresenceEnabled(room.client)) return null;
    return presence;
};

const PRESENCE_BY_STATE: Record<MergedPresenceState, Presence> = {
    online: Presence.Online,
    unavailable: Presence.Away,
    busy: Presence.Busy,
    offline: Presence.Offline,
};

/** A DM partner's status together with wording for it, when the standard name would overstate what is known. */
export interface PresenceDetails {
    presence: Presence | null;
    /** Overrides the standard tooltip and accessible name, e.g. "Active 12m ago" for seen activity. */
    label?: string;
}

/**
 * The status to show for the other person in a DM. With the desktop shell this also uses Aether signals and seen
 * activity, even where the config disables server presence; otherwise it is the server's presence only.
 */
export const usePresenceDetails = (room: Room, member: RoomMember | null): PresenceDetails => {
    const desktopShell = useFeatureEnabled("feature_desktop_shell");
    const serverPresence = useServerPresence(room, member);
    const merged = useMergedPresence(member?.userId);
    if (!desktopShell) return { presence: serverPresence };
    if (getJoinedNonFunctionalMembers(room).length !== 2 || !merged) return { presence: null };
    return { presence: PRESENCE_BY_STATE[merged.state], label: merged.label };
};

const WithPresenceIndicator: React.FC<Props> = ({ room, children }) => {
    const dmMember = useDmMember(room);
    const { presence, label } = usePresenceDetails(room, dmMember);

    let icon: JSX.Element | undefined;
    if (presence) {
        icon = <AvatarPresenceIconView presenceState={presence} label={label} />;
    }

    if (!presence) return <>{children}</>;

    return (
        <div className="mx_WithPresenceIndicator">
            {children}
            <div className="mx_WithPresenceIndicator_icon">{icon}</div>
        </div>
    );
};

export default WithPresenceIndicator;
