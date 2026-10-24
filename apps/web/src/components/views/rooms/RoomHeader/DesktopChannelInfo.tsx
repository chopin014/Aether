/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useState } from "react";
import { ChannelMenuView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";
import { type Room } from "matrix-js-sdk/src/matrix";

import { Action } from "../../../../dispatcher/actions";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { useDispatcher } from "../../../../hooks/useDispatcher";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { RoomListItemViewModel } from "../../../../viewmodels/room-list/RoomListItemViewModel";
import { ChannelMenuViewModel } from "../../../../viewmodels/desktop/ChannelMenuViewModel";

interface Props {
    room: Room;
    /** The channel or person's name with its badges. */
    heading: ReactNode;
    /** The plain text of the channel's topic. */
    topic?: string;
}

/**
 * The channel name, with a chevron, opens the channel menu beneath it. The topic sits beside it. Neither opens the
 * room info panel.
 */
function ChannelInfo({ room, heading, topic }: Props): JSX.Element {
    const client = useMatrixClientContext();
    const [open, setOpen] = useState(false);
    const item = useCreateAutoDisposedViewModel(() => new RoomListItemViewModel({ room, client }));
    const menu = useCreateAutoDisposedViewModel(() => new ChannelMenuViewModel({ room, client, item }));
    useDispatcher(defaultDispatcher, (payload) => {
        if (payload.action === Action.ToggleChannelMenu) setOpen((current) => !current);
    });

    return (
        <div className="mx_RoomHeader_infoWrapper mx_DesktopShell_channelInfo">
            <ChannelMenuView
                vm={menu}
                open={open}
                onOpenChange={setOpen}
                trigger={
                    <button type="button" className="mx_DesktopShell_channelName">
                        {heading}
                        <ChevronDownIcon className="mx_DesktopShell_channelChevron" aria-hidden />
                    </button>
                }
            />
            {topic && (
                <span className="mx_DesktopShell_channelTopic" title={topic} dir="auto">
                    {topic}
                </span>
            )}
        </div>
    );
}

/** The part of a desktop channel header that identifies the room and opens its menu. */
export function DesktopChannelInfo({ room, heading, topic }: Props): JSX.Element {
    // The menu's view models belong to one room.
    return <ChannelInfo key={room.roomId} room={room} heading={heading} topic={topic} />;
}
