/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useContext, useEffect, useReducer } from "react";
import {
    type RoomState,
    RoomStateEvent,
    type MatrixEvent,
    EventType,
    RoomMemberEvent,
    type RoomMember,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { SDKContext } from "../../contexts/SDKContext";
import { useMatrixClientContext } from "../../contexts/MatrixClientContext";
import { useEventEmitter, useTypedEventEmitter } from "../../hooks/useEventEmitter";
import { UPDATE_SELECTED_SPACE } from "../../stores/spaces";
import SettingsStore from "../../settings/SettingsStore";
import { type MemberListViewState } from "../../components/viewmodels/memberlist/MemberListViewModel";
import { groupDesktopMembers, type DesktopMemberListItem } from "./desktopMemberGroups";

/**
 * Derive desktop rows from the existing channel member view model and the selected server's Space roles.
 * Profile actions retain the original channel member, even when a heading uses its Space power level.
 */
export function useDesktopMemberListViewModel(
    roomId: string,
    vm: MemberListViewState,
    enabled: boolean,
): DesktopMemberListItem[] {
    const cli = useMatrixClientContext();
    const sdkContext = useContext(SDKContext);
    const spaceStore = enabled ? sdkContext.spaceStore : undefined;
    const [, refresh] = useReducer((value: number) => value + 1, 0);
    const activeSpace = spaceStore?.activeSpaceRoom;
    const roleSpace =
        activeSpace && (activeSpace.roomId === roomId || spaceStore?.isRoomInSpace(activeSpace.roomId, roomId))
            ? activeSpace
            : null;

    useEventEmitter(spaceStore, UPDATE_SELECTED_SPACE, refresh);
    // SpaceStore emits the Space ID after rebuilding its channel/descendant maps.
    useEventEmitter(spaceStore, activeSpace?.roomId ?? roomId, refresh);
    useTypedEventEmitter(enabled ? cli : undefined, RoomStateEvent.Update, (state: RoomState) => {
        if (state.roomId === roleSpace?.roomId) refresh();
    });
    useTypedEventEmitter(
        enabled ? cli : undefined,
        RoomMemberEvent.PowerLevel,
        (_: MatrixEvent, member: RoomMember) => {
            if (member.roomId === roleSpace?.roomId) refresh();
        },
    );
    useTypedEventEmitter(
        enabled ? cli : undefined,
        RoomMemberEvent.Membership,
        (_: MatrixEvent, member: RoomMember) => {
            if (member.roomId === roleSpace?.roomId) refresh();
        },
    );
    useTypedEventEmitter(enabled ? cli : undefined, RoomStateEvent.Events, (event: MatrixEvent) => {
        if (
            event.getRoomId() === roleSpace?.roomId ||
            event.getType() === EventType.SpaceChild ||
            event.getType() === EventType.SpaceParent
        ) {
            refresh();
        }
    });

    useEffect(() => {
        if (!roleSpace) return;
        let disposed = false;
        // Space membership can be lazy-loaded independently of the open channel's member list.
        void roleSpace.loadMembersIfNeeded().then(
            () => {
                if (!disposed) refresh();
            },
            (error: unknown) => logger.warn("Unable to load Space roles for the member list", error),
        );
        return () => {
            disposed = true;
        };
    }, [roleSpace]);

    return enabled
        ? groupDesktopMembers(vm.members, vm.isPresenceEnabled, roleSpace, SettingsStore.getValue("language"))
        : vm.members;
}
