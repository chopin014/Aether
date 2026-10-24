/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useRef, useState } from "react";
import { ChannelMenuView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";
import { type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import { Action } from "../../../../dispatcher/actions";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { type ViewUserPayload } from "../../../../dispatcher/payloads/ViewUserPayload";
import { useDispatcher } from "../../../../hooks/useDispatcher";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import Modal from "../../../../Modal";
import { RoomListItemViewModel } from "../../../../viewmodels/room-list/RoomListItemViewModel";
import { DesktopTopicDialog } from "../../desktop/DesktopTopicDialog";

interface Props {
    room: Room;
    /** The channel or person's name with its badges. */
    heading: ReactNode;
    /** The other person of a direct message, whose profile the name opens. */
    dmMember: RoomMember | null;
    /** The plain text of the channel's topic. */
    topic?: string;
}

/** A person's name in a direct message opens their profile card, as in Discord. */
function DirectMessageName({ heading, member }: { heading: ReactNode; member: RoomMember }): JSX.Element {
    const button = useRef<HTMLButtonElement>(null);
    useDispatcher(defaultDispatcher, (payload) => {
        // Ctrl+. has no panel to toggle here; clicking the name keeps the card anchored to it.
        if (payload.action === Action.ToggleChannelMenu) button.current?.click();
    });
    return (
        <div className="mx_RoomHeader_infoWrapper mx_DesktopShell_channelInfo">
            <button
                ref={button}
                type="button"
                className="mx_DesktopShell_channelName"
                aria-haspopup="dialog"
                onClick={() => defaultDispatcher.dispatch<ViewUserPayload>({ action: Action.ViewUser, member })}
            >
                {heading}
            </button>
        </div>
    );
}

/**
 * The channel name, with a chevron, opens the channel menu beneath it, and the topic opens a dialog with the
 * whole text. Neither opens the room info panel.
 */
function ChannelInfo({ room, heading, topic }: Omit<Props, "dmMember">): JSX.Element {
    const client = useMatrixClientContext();
    const [open, setOpen] = useState(false);
    const item = useCreateAutoDisposedViewModel(() => new RoomListItemViewModel({ room, client }));
    // The item owns its menu, so StrictMode recreates both together.
    const menu = item.getChannelMenu();
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
                <button
                    type="button"
                    className="mx_DesktopShell_channelTopic"
                    title={topic}
                    aria-haspopup="dialog"
                    dir="auto"
                    onClick={() => Modal.createDialog(DesktopTopicDialog, { room })}
                >
                    {topic}
                </button>
            )}
        </div>
    );
}

/** The part of a desktop room header that identifies the room and opens what Discord opens from it. */
export function DesktopChannelInfo({ room, heading, dmMember, topic }: Props): JSX.Element {
    // The menu's view models belong to one room.
    return dmMember ? (
        <DirectMessageName key={room.roomId} heading={heading} member={dmMember} />
    ) : (
        <ChannelInfo key={room.roomId} room={room} heading={heading} topic={topic} />
    );
}
