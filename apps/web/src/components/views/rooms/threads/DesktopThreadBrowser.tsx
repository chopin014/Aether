/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    DesktopThreadBrowserView,
    DesktopThreadCreateView,
    useCreateAutoDisposedViewModel,
} from "@element-hq/web-shared-components";
import { IconButton } from "@vector-im/compound-web";
import ThreadsIcon from "@vector-im/compound-design-tokens/assets/web/icons/threads-solid";
import { type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import UIStore, { UI_EVENTS } from "../../../../stores/UIStore";

import { _t } from "../../../../languageHandler";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { DesktopThreadBrowserViewModel } from "../../../../viewmodels/threads/DesktopThreadBrowserViewModel";
import { DesktopThreadCreateViewModel } from "../../../../viewmodels/threads/DesktopThreadCreateViewModel";
import dispatcher from "../../../../dispatcher/dispatcher";
import { Action } from "../../../../dispatcher/actions";
import { type ShowThreadPayload } from "../../../../dispatcher/payloads/ShowThreadPayload";
import { notificationLevelToIndicator } from "../../../../utils/notifications";
import { useRoomThreadNotifications } from "../../../../hooks/room/useRoomThreadNotifications";

function BrowserContent({
    room,
    onOpen,
    onCreate,
}: {
    room: Room;
    onOpen: (root: MatrixEvent) => void;
    onCreate: () => void;
}): JSX.Element {
    const client = useMatrixClientContext();
    const vm = useCreateAutoDisposedViewModel(
        () => new DesktopThreadBrowserViewModel({ client, room, onOpen, onCreate }),
    );
    return <DesktopThreadBrowserView vm={vm} />;
}

function CreateContent({
    room,
    onOpen,
    onCancel,
}: {
    room: Room;
    onOpen: (root: MatrixEvent) => void;
    onCancel: () => void;
}): JSX.Element {
    const client = useMatrixClientContext();
    const vm = useCreateAutoDisposedViewModel(
        () => new DesktopThreadCreateViewModel({ client, room, onCreated: onOpen, onCancel }),
    );
    return <DesktopThreadCreateView vm={vm} />;
}

/** Anchors non-modal discovery below the channel header without replacing the member panel. */
export function DesktopThreadBrowser({ room }: { room: Room }): JSX.Element {
    const [mode, setMode] = useState<"closed" | "browse" | "create">("closed");
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ top: 80, left: 0, maxHeight: 448 });
    const id = useId();
    const notifications = useRoomThreadNotifications(room);
    const dismiss = (restoreFocus = true): void => {
        setMode("closed");
        if (restoreFocus) trigger.current?.focus();
    };
    const open = (root: MatrixEvent): void => {
        dismiss(false);
        dispatcher.dispatch<ShowThreadPayload>({ action: Action.ShowThread, rootEvent: root });
    };
    useLayoutEffect(() => {
        if (mode === "closed") return;
        const place = (): void => {
            const header = trigger.current?.closest(".mx_RoomHeader")?.getBoundingClientRect();
            const button = trigger.current?.getBoundingClientRect();
            if (!button) return;
            const top = Math.min(header?.bottom ?? button.bottom, Math.max(8, UIStore.instance.windowHeight - 200));
            const width = Math.min(480, UIStore.instance.windowWidth - 16);
            const left = Math.max(8, Math.min((header?.left ?? 0) + 48, UIStore.instance.windowWidth - width - 8));
            setPosition({ top, left, maxHeight: Math.max(120, UIStore.instance.windowHeight - top - 8) });
        };
        place();
        UIStore.instance.on(UI_EVENTS.Resize, place);
        return () => {
            UIStore.instance.off(UI_EVENTS.Resize, place);
        };
    }, [mode]);
    useEffect(() => {
        if (mode === "closed") return;
        const outside = (event: PointerEvent): void => {
            if (
                event.target instanceof Node &&
                !panel.current?.contains(event.target) &&
                !trigger.current?.contains(event.target)
            )
                dismiss();
        };
        const keyboard = (event: KeyboardEvent): void => {
            if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault();
                event.stopPropagation();
                dismiss();
            }
        };
        document.addEventListener("pointerdown", outside);
        document.addEventListener("keydown", keyboard, true);
        return () => {
            document.removeEventListener("pointerdown", outside);
            document.removeEventListener("keydown", keyboard, true);
        };
    }, [mode]);
    return (
        <>
            <IconButton
                ref={trigger}
                data-desktop-thread-trigger
                tooltip={_t("common|threads")}
                aria-label={_t("common|threads")}
                aria-haspopup="dialog"
                aria-expanded={mode !== "closed"}
                aria-controls={mode !== "closed" ? id : undefined}
                indicator={notificationLevelToIndicator(notifications)}
                onClick={() => (mode === "closed" ? setMode("browse") : dismiss())}
            >
                <ThreadsIcon />
            </IconButton>
            {mode !== "closed" &&
                createPortal(
                    <div
                        ref={panel}
                        id={id}
                        role="dialog"
                        aria-modal="false"
                        aria-label={_t("common|threads")}
                        className="mx_DesktopThreadBrowser"
                        style={{ position: "fixed", zIndex: 100, ...position }}
                    >
                        {mode === "browse" ? (
                            <BrowserContent room={room} onOpen={open} onCreate={() => setMode("create")} />
                        ) : (
                            <CreateContent room={room} onOpen={open} onCancel={() => setMode("browse")} />
                        )}
                    </div>,
                    document.body,
                )}
        </>
    );
}
