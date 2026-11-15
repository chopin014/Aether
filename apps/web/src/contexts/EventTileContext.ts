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
}

/**
 * The fields of the room context an `EventTile` reads, provided alongside it by `ScopedRoomContextProvider`. The whole
 * room context changes with every change to the room view's state, and a class component re-renders on every change
 * of its context whatever its `shouldComponentUpdate` says, so each tile would redraw with it. This one changes only
 * when one of these fields does. Its defaults are the room context's own.
 */
export const EventTileContext = createContext<EventTileContextValue>({
    isRoomEncrypted: null,
    timelineRenderingType: TimelineRenderingType.Room,
    showHiddenEvents: false,
});
EventTileContext.displayName = "EventTileContext";
