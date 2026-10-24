/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useContext, useRef } from "react";
import { DesktopSearchResultsView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import RoomContext, { TimelineRenderingType } from "../../../contexts/RoomContext";
import { ScopedRoomContextProvider } from "../../../contexts/ScopedRoomContext";
import { useTypedEventEmitterState } from "../../../hooks/useEventEmitter";
import { DESKTOP_SEARCH_UPDATE, DesktopMessageSearchStore } from "../../../stores/DesktopMessageSearchStore";
import { DesktopSearchResultsViewModel } from "../../../viewmodels/search/DesktopSearchResultsViewModel";
import { RoomPermalinkCreator } from "../../../utils/permalinks/Permalinks";
import MemberAvatar from "../avatars/MemberAvatar";
import MessageEvent from "../messages/MessageEvent";
import { type ActiveDesktopSearch } from "../../../stores/DesktopMessageSearchStore";

function ResultsContent({ search }: { search: ActiveDesktopSearch }): JSX.Element {
    const client = useMatrixClientContext();
    const context = useContext(RoomContext);
    const permalinkCreators = useRef(new Map<string, RoomPermalinkCreator>());
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new DesktopSearchResultsViewModel({
                client,
                search,
                onClose: () => DesktopMessageSearchStore.instance.close(),
            }),
    );

    const permalinkCreatorFor = (room: Room): RoomPermalinkCreator => {
        let creator = permalinkCreators.current.get(room.roomId);
        if (!creator) {
            creator = new RoomPermalinkCreator(room);
            permalinkCreators.current.set(room.roomId, creator);
        }
        return creator;
    };

    return (
        <ScopedRoomContextProvider {...context} timelineRenderingType={TimelineRenderingType.Search}>
            <DesktopSearchResultsView
                vm={vm}
                renderAvatar={(row) => {
                    const event = vm.getEvent(row.id);
                    return (
                        event && <MemberAvatar member={event.sender} fallbackUserId={event.getSender()} size="40px" />
                    );
                }}
                renderAttachment={(row) => {
                    // Element's own message renderer, so media is fetched with authorisation and never hot-linked.
                    const event = vm.getEvent(row.id);
                    const room = event && client.getRoom(event.getRoomId());
                    return (
                        event &&
                        room && (
                            <MessageEvent
                                key={row.id}
                                mxEvent={event}
                                maxImageHeight={200}
                                permalinkCreator={permalinkCreatorFor(room)}
                                replacingEventId={event.replacingEventId()}
                            />
                        )
                    );
                }}
            />
        </ScopedRoomContextProvider>
    );
}

/** The right-column results of the desktop message search. Renders nothing while no search is active. */
export function DesktopSearchResultsHost(): JSX.Element | null {
    const search = useTypedEventEmitterState(
        DesktopMessageSearchStore.instance,
        DESKTOP_SEARCH_UPDATE,
        () => DesktopMessageSearchStore.instance.active,
    );
    return search ? <ResultsContent key={search.id} search={search} /> : null;
}
