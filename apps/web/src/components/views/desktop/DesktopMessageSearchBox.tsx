/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useContext, useMemo } from "react";
import { DesktopSearchBoxView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import type SpaceStore from "../../../stores/spaces/SpaceStore";
import { SDKContext } from "../../../contexts/SDKContext";
import { UPDATE_SELECTED_SPACE } from "../../../stores/spaces";
import { DesktopMessageSearchStore } from "../../../stores/DesktopMessageSearchStore";
import {
    DesktopSearchBoxViewModel,
    type DesktopSearchScopeProvider,
} from "../../../viewmodels/search/DesktopSearchBoxViewModel";

/** Gives the search the active space and the searchable rooms in it, or nothing outside a space. */
function createSpaceScopeProvider(
    client: ReturnType<typeof useMatrixClientContext>,
    spaceStore: SpaceStore,
): DesktopSearchScopeProvider {
    return {
        get: () => {
            const space = spaceStore.activeSpaceRoom;
            if (!space) return {};
            const roomIds = [...spaceStore.getSpaceFilteredRoomIds(space.roomId)].filter((id) => {
                const room = client.getRoom(id);
                return !!room && !room.isSpaceRoom() && room.getMyMembership() === "join";
            });
            return { space: { roomId: space.roomId, name: space.name, roomIds: new Set(roomIds) } };
        },
        subscribe: (listener) => {
            spaceStore.on(UPDATE_SELECTED_SPACE, listener);
            return () => void spaceStore.off(UPDATE_SELECTED_SPACE, listener);
        },
    };
}

/**
 * The header search field of the desktop shell. It searches the active space, or just this room for a DM or a room
 * outside the space. Results appear in the right column. Mount it with `key={room.roomId}` so it follows the room.
 */
export function DesktopMessageSearchBox({ room }: { room: Room }): JSX.Element {
    const client = useMatrixClientContext();
    const { spaceStore } = useContext(SDKContext);
    const scope = useMemo(() => createSpaceScopeProvider(client, spaceStore), [client, spaceStore]);
    const vm = useCreateAutoDisposedViewModel(
        () => new DesktopSearchBoxViewModel({ client, room, scope, store: DesktopMessageSearchStore.instance }),
    );
    return <DesktopSearchBoxView vm={vm} />;
}
