/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createContext } from "react";

import { TimelineRenderingType } from "./RoomContext";

/** What an event tile reads of the room view it is drawn in; see {@link EventTileContext}. */
export interface EventTileContextValue {
    readonly isRoomEncrypted: boolean | null;
    readonly timelineRenderingType: TimelineRenderingType;
    readonly showHiddenEvents: boolean;
    /**
     * Grows once when the main thread is next idle after any other change to the room view. A tile reads much else
     * as it renders, such as members, permissions, settings and threads, which used to refresh as every change to the
     * room view redrew every tile; this keeps that, outside the change's own commit, such as while a room opens.
     */
    readonly refresh: number;
}

/**
 * The fields of the room context an `EventTile` reads, provided alongside it by `ScopedRoomContextProvider`. The whole
 * room context changes with every change to the room view's state, and a class component re-renders on every change
 * of its context whatever its `shouldComponentUpdate` says, so each tile would redraw with it, many times as a room
 * opens. This one changes at once only when one of these fields does, and otherwise once the change has settled; see
 * `refresh`. Its defaults are the room context's own.
 */
export const EventTileContext = createContext<EventTileContextValue>({
    isRoomEncrypted: null,
    timelineRenderingType: TimelineRenderingType.Room,
    showHiddenEvents: false,
    refresh: 0,
});
EventTileContext.displayName = "EventTileContext";
