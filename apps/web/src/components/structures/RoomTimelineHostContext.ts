/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ComponentProps, createContext, type FocusEvent, type KeyboardEvent } from "react";

import type { RoomContextType } from "../../contexts/RoomContext";
import type { RoomUploadViewModel } from "../../viewmodels/room/RoomUploadViewModel";
import type { RoomTimelineLease, RoomTimelineRequest } from "../../viewmodels/room/timeline/RoomTimelineHostViewModel";
import type { NewTimelineRenderer } from "./NewTimelineRenderer";
import type { RoomMessagePanel } from "./RoomMessagePanel";

/**
 * What the room view hands the host for its timeline: what to draw it with, and what of the room view it would have
 * found around it had the room view drawn it itself. The host draws the timeline elsewhere in React's tree, so none of
 * the room view's contexts or event handlers reach it otherwise.
 */
export interface RoomTimelineSlotPacket {
    /** What the timeline is made for; read once, as the binding is made. */
    readonly request: RoomTimelineRequest;
    /** What the timeline is drawn with, as the room view would give it. */
    readonly renderer: Omit<ComponentProps<typeof NewTimelineRenderer>, "vm" | "panelRef" | "execution">;
    /** See `NewTimelinePanel`'s `sendReadReceiptOnLoad`; followed as it changes. */
    readonly sendReadReceiptOnLoad: boolean;
    /** Receives the timeline's controls, as the room view's own panel ref would. */
    readonly panelRef: (panel: RoomMessagePanel | null) => void;
    /** The room context around the room view's timeline. */
    readonly roomContext: RoomContextType;
    /** The room's upload service, which the room view's composer and drop target share with the timeline. */
    readonly upload: RoomUploadViewModel | null;
    /** The room view's own handlers, which keys and focus in its timeline reach as they bubble. */
    readonly onKeyDown: (event: KeyboardEvent) => void;
    readonly onFocus: (event: FocusEvent) => void;
    /** Called once the host has given the timeline up after an error in drawing it, so the room view draws its own. */
    readonly onFailed: () => void;
}

/** How a room view's timeline slot lends its place to the host. */
export interface RoomTimelineHostController {
    /**
     * Draw the timeline `packet` asks for into `slot`, an empty element of the room view's, and return its lease. Null
     * when the host will not, so that the room view draws its timeline itself.
     */
    bind: (slot: HTMLElement, packet: RoomTimelineSlotPacket) => RoomTimelineLease | null;
    /** Draw the timeline under `lease` with what the room view now gives it. */
    update: (lease: RoomTimelineLease, packet: RoomTimelineSlotPacket) => void;
    /** Stop drawing the timeline under `lease`, and dispose of it, if it is still the current one. */
    release: (lease: RoomTimelineLease) => void;
}

/** The host that draws the main room view's timeline, when the room timeline host lab is on. */
export const RoomTimelineHostContext = createContext<RoomTimelineHostController | null>(null);
