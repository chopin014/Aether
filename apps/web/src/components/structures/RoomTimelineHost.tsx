/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    useCreateAutoDisposedViewModel,
    useViewModel,
    type TimelineViewExecution,
} from "@element-hq/web-shared-components";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import {
    RoomTimelineHostViewModel,
    type RoomTimelineLease,
} from "../../viewmodels/room/timeline/RoomTimelineHostViewModel";
import type { RoomTimelineViewModel } from "../../viewmodels/room/timeline/RoomTimelineViewModel";
import { ScopedRoomContextProvider } from "../../contexts/ScopedRoomContext";
import { RoomUploadContext } from "../../viewmodels/room/RoomUploadViewModel";
import { EventPresentationContextProvider } from "../../utils/EventPresentationContextProvider";
import { Layout } from "../../settings/enums/Layout";
import ErrorBoundary from "../views/elements/ErrorBoundary";
import { NewTimelineRenderer } from "./NewTimelineRenderer";
import {
    RoomTimelineHostContext,
    type RoomTimelineHostController,
    type RoomTimelineSlotPacket,
} from "./RoomTimelineHostContext";

/** The timeline the host draws: its lease, the element it is drawn into, and what the room view last gave it. */
interface Docked {
    readonly lease: RoomTimelineLease;
    readonly container: HTMLElement;
    readonly packet: RoomTimelineSlotPacket;
}

interface Props {
    /** The client whose rooms are drawn; see `RoomTimelineHostViewModel`. */
    client: MatrixClient;
    children: ReactNode;
}

/**
 * Draws the main room view's timeline, which the room view lends it through a `RoomTimelineSlot`, when the room
 * timeline host lab is on.
 *
 * The timeline is drawn into an element of the host's own, which the host puts inside the slot, so it sits where the
 * room view would have drawn it while belonging to the host in React's tree. The host owns the timeline's view model
 * and disposes of it once the slot is released: in this first version a timeline lives as long as the room view's
 * slot, and the room view's contexts and key and focus handlers are passed on to it from the slot.
 */
export function RoomTimelineHost({ client, children }: Readonly<Props>): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new RoomTimelineHostViewModel({ client }));
    const { entry } = useViewModel(vm);
    const [docked, setDocked] = useState<Docked | null>(null);

    const controller = useMemo<RoomTimelineHostController>(
        () => ({
            bind: (slot, packet) => {
                const lease = vm.bind(packet.request);
                if (!lease) return null;
                const container = document.createElement("div");
                container.className = "mx_RoomTimelineHost_entry";
                slot.append(container);
                setDocked({ lease, container, packet });
                return lease;
            },
            update: (lease, packet) => {
                if (!vm.isCurrent(lease)) return;
                setDocked((current) =>
                    current?.lease === lease && current.packet !== packet ? { ...current, packet } : current,
                );
            },
            release: (lease) => {
                if (!vm.isCurrent(lease)) return;
                vm.release(lease);
                setDocked((current) => (current?.lease === lease ? null : current));
            },
        }),
        [vm],
    );

    // Taken out of the slot once React has emptied it, as the timeline drawn into it goes.
    const container = docked?.container;
    useLayoutEffect(() => {
        if (!container) return;
        return () => container.remove();
    }, [container]);

    const current = docked && entry?.lease === docked.lease ? docked : null;
    return (
        <RoomTimelineHostContext.Provider value={controller}>
            {children}
            {current &&
                entry &&
                createPortal(
                    <HostedTimeline host={vm} timeline={entry.vm} docked={current} onError={controller.release} />,
                    current.container,
                    String(current.lease.entryId),
                )}
        </RoomTimelineHostContext.Provider>
    );
}

interface HostedTimelineProps {
    host: RoomTimelineHostViewModel;
    timeline: RoomTimelineViewModel;
    docked: Docked;
    /** Gives the timeline up, as an error in drawing it leaves nothing to show. */
    onError: (lease: RoomTimelineLease) => void;
}

/** One timeline the host draws, around it what the room view would have had around it, as `NewTimelinePanel` does. */
function HostedTimeline({ host, timeline, docked, onError }: Readonly<HostedTimelineProps>): JSX.Element {
    const { lease, packet } = docked;

    // The timeline may act only while its lease is current: once released, what it still has scheduled is dropped.
    const execution = useMemo<TimelineViewExecution>(
        () => ({ revision: 1, isCurrent: () => host.isCurrent(lease), onPlaced: () => host.isCurrent(lease) }),
        [host, lease],
    );

    const sendReadReceiptOnLoad = packet.sendReadReceiptOnLoad;
    useEffect(() => {
        timeline.setSendReadReceiptOnLoad(sendReadReceiptOnLoad);
    }, [timeline, sendReadReceiptOnLoad]);
    useEffect(() => {
        timeline.start();
        // The host disposes of it as the lease is released.
    }, [timeline]);

    return (
        <ErrorBoundary
            onError={() => {
                // Disposed of at once, rather than left running behind the error, and the room view draws its own.
                onError(lease);
                packet.onFailed();
            }}
        >
            <ScopedRoomContextProvider {...packet.roomContext}>
                <RoomUploadContext.Provider value={packet.upload}>
                    <EventPresentationContextProvider layout={packet.renderer.layout ?? Layout.Group}>
                        <div
                            className="mx_RoomTimelineHost_events"
                            onKeyDown={packet.onKeyDown}
                            onFocus={packet.onFocus}
                        >
                            <NewTimelineRenderer
                                {...packet.renderer}
                                vm={timeline}
                                panelRef={packet.panelRef}
                                execution={execution}
                            />
                        </div>
                    </EventPresentationContextProvider>
                </RoomUploadContext.Provider>
            </ScopedRoomContextProvider>
        </ErrorBoundary>
    );
}
