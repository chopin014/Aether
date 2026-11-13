/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { useEffect, type JSX } from "react";
import { useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { RoomTimelineViewModel } from "../../viewmodels/room/timeline/RoomTimelineViewModel";
import { useMatrixClientContext } from "../../contexts/MatrixClientContext";
import { NewTimelineRenderer, type NewTimelineRendererProps } from "./NewTimelineRenderer";

/** A room timeline that owns its view model; see {@link NewTimelinePanel}. */
export interface NewTimelinePanelProps extends NewTimelineRendererProps {
    /**
     * Whether what the timeline shows once it has loaded is read straight away, without waiting for the reader to be
     * active. The room view sets it when the reader opened the room themselves, as for the old timeline.
     */
    sendReadReceiptOnLoad?: boolean;
    /**
     * Whether read receipts and the fully read marker move on by themselves while the reader is active. When off, as
     * in a room view a module embeds, they move only when the room view asks, on focus. Read once, when the panel is
     * created, as by the old timeline. Default true.
     */
    enableReadReceiptsAndMarkersOnActivity?: boolean;
}

/**
 * The MVVM room timeline: the shared TimelineView from shared-components with a RoomTimelineViewModel. Used
 * unless `feature_new_timeline` is turned off.
 *
 * It makes the view model for as long as it is mounted, starts it and disposes of it, and draws it with
 * {@link NewTimelineRenderer}.
 */
export function NewTimelinePanel({
    sendReadReceiptOnLoad = false,
    enableReadReceiptsAndMarkersOnActivity = true,
    ...rendererProps
}: Readonly<NewTimelinePanelProps>): JSX.Element {
    const client = useMatrixClientContext();
    const { room, highlightedEventId, showReadReceipts = true } = rendererProps;

    // Creating the view model does nothing on its own — it starts listening only
    // when start() is called in the effect below. React can build one of these and
    // throw it away, and anything it had already started would have leaked.
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new RoomTimelineViewModel({
                client,
                room,
                initialEventId: highlightedEventId,
                showReadReceipts,
                sendReadReceiptOnLoad,
                enableReadReceiptsAndMarkersOnActivity,
            }),
    );

    useEffect(() => {
        vm.setSendReadReceiptOnLoad(!!sendReadReceiptOnLoad);
    }, [vm, sendReadReceiptOnLoad]);

    useEffect(() => {
        vm.start();
        // Disposal is handled by useCreateAutoDisposedViewModel; no cleanup needed here.
    }, [vm]);

    return <NewTimelineRenderer vm={vm} {...rendererProps} />;
}
