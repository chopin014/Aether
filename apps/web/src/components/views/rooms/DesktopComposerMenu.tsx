/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";
import { type IEventRelation, type Room, THREAD_RELATION_TYPE } from "matrix-js-sdk/src/matrix";
import { LiveIcons, useViewModel } from "@element-hq/web-shared-components";

import { _t } from "../../../languageHandler";
import { alwaysAboveRightOf, ChevronFace, type MenuProps, useContextMenu } from "../../structures/ContextMenu";
import IconizedContextMenu, {
    IconizedContextMenuOption,
    IconizedContextMenuOptionList,
} from "../context_menus/IconizedContextMenu";
import AccessibleButton, { type ButtonEvent } from "../elements/AccessibleButton";
import { OverflowMenuContext } from "./CollapsibleButton";
import { PollButton } from "./MessageComposerButtons";
import { LocationButton } from "../location";
import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { useRoomUploadViewModel } from "../../../viewmodels/room/RoomUploadViewModel";

interface DesktopComposerMenuProps {
    room: Room;
    relation?: IEventRelation;
    /** Whether the room lets this user start polls. */
    showPollsButton: boolean;
    /** Whether location sharing is available on this platform. */
    showLocationButton: boolean;
    /** Where the location picker opens, beside the composer like the other composer menus. */
    menuPosition?: MenuProps;
}

/**
 * The plus at the start of the desktop composer. Like Discord's, it opens a menu of things to add to a message:
 * files, a poll, a location. With nothing but a single way to upload, it opens the file picker straight away, and
 * Ctrl+click always does.
 */
export function DesktopComposerMenu({
    room,
    relation,
    showPollsButton,
    showLocationButton,
    menuPosition,
}: DesktopComposerMenuProps): JSX.Element {
    const client = useMatrixClientContext();
    const uploadVm = useRoomUploadViewModel();
    const { options: uploadOptions } = useViewModel(uploadVm);
    const [menuDisplayed, button, openMenu, closeMenu] = useContextMenu<HTMLDivElement>();

    // Polls cannot be sent within threads, and a location needs the sender's own membership.
    const poll = showPollsButton && relation?.rel_type !== THREAD_RELATION_TYPE.name;
    const sender = showLocationButton ? room.getMember(client.getSafeUserId()) : null;

    const extras: ReactNode[] = [];
    if (poll) extras.push(<PollButton key="poll" room={room} relation={relation} />);
    if (sender) {
        extras.push(
            <LocationButton
                key="location"
                roomId={room.roomId}
                relation={relation}
                sender={sender}
                menuPosition={menuPosition}
            />,
        );
    }

    const onClick = (ev: ButtonEvent): void => {
        const firstUpload = uploadOptions[0];
        const shortcut = (ev as React.MouseEvent).ctrlKey || (uploadOptions.length === 1 && extras.length === 0);
        if (firstUpload && shortcut) {
            uploadVm.onUploadOptionSelected(firstUpload.type);
        } else {
            openMenu();
        }
    };

    let menu: JSX.Element | undefined;
    if (menuDisplayed && button.current) {
        menu = (
            <IconizedContextMenu
                {...alwaysAboveRightOf(button.current.getBoundingClientRect(), ChevronFace.None, 12)}
                onFinished={closeMenu}
                wrapperClassName="mx_DesktopComposerMenu"
                compact
            >
                <OverflowMenuContext.Provider value={closeMenu}>
                    <IconizedContextMenuOptionList>
                        {uploadOptions.map(({ type, icon: Icon, label }) => (
                            <IconizedContextMenuOption
                                key={type}
                                // The app's own upload reads as an action here, like the menu's other entries.
                                label={type === "local" ? _t("action|upload_file") : label}
                                icon={Icon && <Icon />}
                                onClick={() => {
                                    closeMenu();
                                    uploadVm.onUploadOptionSelected(type);
                                }}
                            />
                        ))}
                        {extras}
                    </IconizedContextMenuOptionList>
                </OverflowMenuContext.Provider>
            </IconizedContextMenu>
        );
    }

    return (
        <>
            <AccessibleButton
                className="mx_DesktopShell_attachment"
                onClick={onClick}
                title={_t("composer|add_to_message")}
                aria-haspopup="menu"
                aria-expanded={menuDisplayed}
                ref={button}
            >
                <LiveIcons.AddIcon />
            </AccessibleButton>
            {menu}
        </>
    );
}
