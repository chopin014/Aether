/*
 * Copyright 2025 New Vector Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useCallback, type JSX, type ReactNode, useContext, useEffect } from "react";
import {
    RoomListView as SharedRoomListView,
    useCreateAutoDisposedViewModel,
    type Room as SharedRoom,
} from "@element-hq/web-shared-components";
import { Room } from "matrix-js-sdk/src/matrix";

import { DecoratedRoomAvatarView } from "../../avatars/DecoratedRoomAvatarView";
import RoomAvatar from "../../avatars/RoomAvatar";
import { PreviewRoomAvatarData } from "../../../../viewmodels/room-list/PreviewRoomAvatarData";
import { getKeyBindingsManager } from "../../../../KeyBindingsManager";
import { KeyBindingAction } from "../../../../accessibility/KeyboardShortcuts";
import { Landmark, LandmarkNavigation } from "../../../../accessibility/LandmarkNavigation";
import { RoomListViewModel } from "../../../../viewmodels/room-list/RoomListViewModel";
import { SDKContext } from "../../../../contexts/SDKContext.ts";
import { markStartup } from "../../../../performance/StartupTimings";

/**
 * RoomListView component using shared components with proper MVVM pattern.
 */
export function RoomListView(): JSX.Element {
    const sdkContext = useContext(SDKContext);

    // Create and auto-dispose ViewModel instance
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new RoomListViewModel({
                client: sdkContext.client!,
                roomViewStore: sdkContext.roomViewStore,
                spaceStore: sdkContext.spaceStore,
            }),
    );

    // Record when people first see their chats, so slow startups can be measured on real accounts.
    useEffect(() => {
        const markWhenShown = (): void => {
            if (vm.getSnapshot().isLoadingRooms) return;
            requestAnimationFrame(() => markStartup("chats_shown"));
            unsubscribe();
        };
        const unsubscribe = vm.subscribe(markWhenShown);
        markWhenShown();
        return unsubscribe;
    }, [vm]);

    // Render avatar for each room - memoized to prevent re-renders
    const renderAvatar = useCallback((room: SharedRoom): ReactNode => {
        if (room instanceof Room) return <DecoratedRoomAvatarView room={room} />;
        // A preview item has no `Room`, only the data needed for its avatar
        if (room instanceof PreviewRoomAvatarData) return <RoomAvatar size="32px" oobData={room} />;
        return null;
    }, []);

    // Handle keyboard navigation for landmarks
    const onKeyDown = useCallback((ev: React.KeyboardEvent) => {
        const navAction = getKeyBindingsManager().getNavigationAction(ev);
        if (navAction === KeyBindingAction.NextLandmark || navAction === KeyBindingAction.PreviousLandmark) {
            LandmarkNavigation.findAndFocusNextLandmark(
                Landmark.ROOM_LIST,
                navAction === KeyBindingAction.PreviousLandmark,
            );
            ev.stopPropagation();
            ev.preventDefault();
        }
    }, []);

    return <SharedRoomListView vm={vm} renderAvatar={renderAvatar} onKeyDown={onKeyDown} />;
}
