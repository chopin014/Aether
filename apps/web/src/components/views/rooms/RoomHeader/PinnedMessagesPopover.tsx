/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { IconButton } from "@vector-im/compound-web";
import PinIcon from "@vector-im/compound-design-tokens/assets/web/icons/pin";
import { PinnedMessagesView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import { useAnchoredPopoverPosition } from "../../../../hooks/useAnchoredPopoverPosition";
import Modal, { ModalManagerEvent } from "../../../../Modal";
import { _t } from "../../../../languageHandler";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import RoomContext, { TimelineRenderingType } from "../../../../contexts/RoomContext";
import { ScopedRoomContextProvider } from "../../../../contexts/ScopedRoomContext";
import { PinnedMessagesViewModel } from "../../../../viewmodels/room/PinnedMessagesViewModel";
import { RoomPermalinkCreator } from "../../../../utils/permalinks/Permalinks";
import MemberAvatar from "../../avatars/MemberAvatar";
import MessageEvent from "../../messages/MessageEvent";

/** Matrix renderer adapter, mounted only while the pin browser is open. */
function PinnedMessagesContent({ room, onClose }: { room: Room; onClose(this: void): void }): JSX.Element {
    const client = useMatrixClientContext();
    const context = useContext(RoomContext);
    const vm = useCreateAutoDisposedViewModel(() => new PinnedMessagesViewModel({ room, client, onClose }));
    const permalinkCreator = useMemo(() => new RoomPermalinkCreator(room), [room]);
    return (
        <ScopedRoomContextProvider {...context} timelineRenderingType={TimelineRenderingType.Pinned}>
            <PinnedMessagesView
                vm={vm}
                renderAvatar={(id) => {
                    const event = vm.getEvent(id);
                    return (
                        event && <MemberAvatar member={event.sender} fallbackUserId={event.getSender()} size="32px" />
                    );
                }}
                renderMessage={(id) => {
                    const event = vm.getEvent(id);
                    return (
                        event && (
                            <MessageEvent
                                key={id}
                                mxEvent={event}
                                maxImageHeight={160}
                                permalinkCreator={permalinkCreator}
                                replacingEventId={event.replacingEventId()}
                            />
                        )
                    );
                }}
            />
        </ScopedRoomContextProvider>
    );
}

/** Header pin trigger and native nonmodal popover, preserving the channel and member panel behind it. */
export function PinnedMessagesPopover({ room }: { room: Room }): JSX.Element {
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const popover = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const close = useCallback(() => {
        popover.current?.hidePopover();
        trigger.current?.focus();
    }, []);

    useEffect(() => {
        if (!open) return;
        // Media viewers and verification dialogs must remain above this native top-layer surface.
        const dismissForModal = (): void => popover.current?.hidePopover();
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
        };
        Modal.on(ModalManagerEvent.Opened, dismissForModal);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            Modal.off(ModalManagerEvent.Opened, dismissForModal);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [open, close]);

    useAnchoredPopoverPosition(open, trigger, ({ top, left, width, availableHeight }) => {
        const panel = popover.current;
        if (!panel) return;
        panel.style.width = `${width}px`;
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.setProperty("--pinned-messages-available-height", `${Math.max(0, availableHeight - 80)}px`);
    });

    return (
        <>
            <IconButton
                ref={trigger}
                tooltip={_t("right_panel|pinned_messages_button")}
                aria-label={_t("right_panel|pinned_messages_button")}
                aria-expanded={open}
                aria-controls={id}
                aria-haspopup="dialog"
                popoverTarget={id}
                popoverTargetAction="toggle"
                className={open ? "mx_PinnedMessagesPopover_active" : undefined}
            >
                <PinIcon />
            </IconButton>
            <div
                id={id}
                ref={popover}
                popover="auto"
                role="dialog"
                aria-label={_t("right_panel|pinned_messages_button")}
                className="mx_PinnedMessagesPopover"
                onToggle={(event) => setOpen(event.newState === "open")}
            >
                {open && <PinnedMessagesContent room={room} onClose={close} />}
            </div>
        </>
    );
}
