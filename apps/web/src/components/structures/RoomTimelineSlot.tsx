/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, {
    type ComponentProps,
    type FocusEvent,
    type JSX,
    type KeyboardEvent,
    useContext,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import RoomContext from "../../contexts/RoomContext";
import { useMatrixClientContext } from "../../contexts/MatrixClientContext";
import { RoomUploadContext } from "../../viewmodels/room/RoomUploadViewModel";
import type { RoomTimelineLease } from "../../viewmodels/room/timeline/RoomTimelineHostViewModel";
import { markRoomSwitch } from "../../performance/RoomSwitchPerformance";
import { NewTimelinePanel } from "./NewTimelinePanel";
import type { RoomMessagePanel } from "./RoomMessagePanel";
import {
    RoomTimelineHostContext,
    type RoomTimelineHostController,
    type RoomTimelineSlotPacket,
} from "./RoomTimelineHostContext";

interface Props extends Omit<ComponentProps<typeof NewTimelinePanel>, "panelRef"> {
    /** Receives the timeline's controls. */
    panelRef: (panel: RoomMessagePanel | null) => void;
    /** The room view's own handlers, which keys and focus in its timeline would reach as they bubble. */
    onKeyDown: (event: KeyboardEvent) => void;
    onFocus: (event: FocusEvent) => void;
}

/**
 * The place of the room view's timeline, which it lends to the `RoomTimelineHost` above it, when the room timeline
 * host lab is on. The host draws the timeline into it, with what this hands it from the room view; should there be no
 * host, or should it decline, the room view's timeline is drawn here as usual, by a `NewTimelinePanel`.
 */
export function RoomTimelineSlot({
    panelRef,
    onKeyDown,
    onFocus,
    sendReadReceiptOnLoad = false,
    enableReadReceiptsAndMarkersOnActivity = true,
    ...renderer
}: Readonly<Props>): JSX.Element {
    const host = useContext(RoomTimelineHostContext);
    const client = useMatrixClientContext();
    const roomContext = useContext(RoomContext);
    const upload = useContext(RoomUploadContext);
    const slotRef = useRef<HTMLDivElement>(null);
    const leaseRef = useRef<RoomTimelineLease | null>(null);
    // The host that declined to draw the timeline, or gave it up after an error. A new host, such as the one React
    // makes again as it replays effects in StrictMode, is asked afresh.
    const [declinedBy, setDeclinedBy] = useState<RoomTimelineHostController | null>(null);
    const declined = !host || declinedBy === host;

    const packet: RoomTimelineSlotPacket = {
        request: {
            client,
            room: renderer.room,
            initialEventId: renderer.highlightedEventId,
            showReadReceipts: renderer.showReadReceipts ?? true,
            sendReadReceiptOnLoad,
            enableReadReceiptsAndMarkersOnActivity,
        },
        renderer,
        sendReadReceiptOnLoad,
        panelRef,
        roomContext,
        upload,
        onKeyDown,
        onFocus,
    };
    const packetRef = useRef(packet);
    packetRef.current = packet;

    // Lent once the slot is in the page, for as long as it shows this room's timeline. As with `NewTimelinePanel`,
    // what the timeline is made with is read once, and a later change to it is not followed.
    const room = renderer.room;
    useLayoutEffect(() => {
        const slot = slotRef.current;
        if (!host || !slot) return;
        const lease = host.bind(slot, packetRef.current);
        if (!lease) {
            setDeclinedBy(host);
            return;
        }
        markRoomSwitch("slot", room.roomId);
        leaseRef.current = lease;
        return () => {
            leaseRef.current = null;
            host.release(lease);
        };
    }, [host, room, client, enableReadReceiptsAndMarkersOnActivity, declined]);

    // What the room view gives its timeline as it renders, which the host draws it with before the paint.
    useLayoutEffect(() => {
        const lease = leaseRef.current;
        if (lease) host?.update(lease, packet);
    });

    if (declined) {
        return (
            <NewTimelinePanel
                {...renderer}
                panelRef={panelRef}
                sendReadReceiptOnLoad={sendReadReceiptOnLoad}
                enableReadReceiptsAndMarkersOnActivity={enableReadReceiptsAndMarkersOnActivity}
            />
        );
    }
    return <div className="mx_RoomTimelineSlot" ref={slotRef} />;
}
