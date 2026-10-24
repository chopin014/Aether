/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DesktopProfilePopoutView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room, type RoomMember, type User } from "matrix-js-sdk/src/matrix";

import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { type ActionPayload } from "../../../dispatcher/payloads";
import { type ViewUserPayload } from "../../../dispatcher/payloads/ViewUserPayload";
import Modal, { ModalManagerEvent } from "../../../Modal";
import UIStore, { UI_EVENTS } from "../../../stores/UIStore";
import { _t } from "../../../languageHandler";
import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { SDKContext } from "../../../contexts/SDKContext";
import { DesktopProfileViewModel } from "../../../viewmodels/profile/DesktopProfileViewModel";
import { placeProfilePopout } from "../../../utils/profilePopoutPlacement";
import { readWindowControls } from "../../../utils/windowControls";
import { DesktopFullProfileDialog } from "./DesktopFullProfileDialog";

/** How long after a click an `Action.ViewUser` is still attributed to it. */
const CLICK_ATTRIBUTION_MS = 1000;
const INTERACTIVE = "button, a, [role='button'], [role='option'], [tabindex]";

interface Request {
    member: RoomMember | User;
    anchor: HTMLElement;
    room?: Room;
    roleSpace: Room | null;
    isRoomViewed: boolean;
}

/** Work out which room gives the person their roles: the one they were clicked in, else the room being viewed. */
function useProfileContext(): (member: RoomMember | User) => Omit<Request, "member" | "anchor"> {
    const client = useMatrixClientContext();
    const sdk = useContext(SDKContext);
    return useCallback(
        (member) => {
            const viewedId = sdk.roomViewStore.getRoomId();
            const roomId = ("roomId" in member && member.roomId) || viewedId;
            const room = (roomId && client.getRoom(roomId)) || undefined;
            const active = sdk.spaceStore.activeSpaceRoom;
            const roleSpace =
                room &&
                active &&
                (active.roomId === room.roomId || sdk.spaceStore.isRoomInSpace(active.roomId, room.roomId))
                    ? active
                    : null;
            return { room, roleSpace, isRoomViewed: !!room && room.roomId === viewedId };
        },
        [client, sdk],
    );
}

function PopoutCard({
    request,
    onClose,
    onOpenFull,
}: {
    request: Request;
    onClose: () => void;
    onOpenFull: () => void;
}): JSX.Element {
    const client = useMatrixClientContext();
    const sdk = useContext(SDKContext);
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new DesktopProfileViewModel({
                client,
                member: request.member,
                room: request.room,
                roleSpace: request.roleSpace,
                isRoomViewed: request.isRoomViewed,
                rightPanelStore: sdk.rightPanelStore,
                full: false,
                onClose,
                onOpenFull,
            }),
    );
    return <DesktopProfilePopoutView vm={vm} />;
}

/**
 * Presents a person as a small anchored card when something asks to view them, in place of the right-hand
 * info panel. The click that asked is recorded so the card can sit beside it and return focus to it.
 */
export function DesktopProfileHost(): JSX.Element | null {
    const client = useMatrixClientContext();
    const sdk = useContext(SDKContext);
    const resolveContext = useProfileContext();
    const [request, setRequest] = useState<Request | null>(null);
    const current = useRef<Request | null>(null);
    current.current = request;
    const lastClick = useRef<{ element: Element; at: number }>(undefined);
    const panel = useRef<HTMLDivElement>(null);
    const id = useId();

    useEffect(() => {
        const record = (event: MouseEvent): void => {
            if (event.target instanceof Element) lastClick.current = { element: event.target, at: Date.now() };
        };
        document.addEventListener("click", record, true);
        return () => document.removeEventListener("click", record, true);
    }, []);

    const openFull = useCallback(
        (current: Omit<Request, "anchor"> & { anchor?: HTMLElement }) => {
            // Focus goes back to the trigger first so the modal's focus trap returns there when it closes.
            current.anchor?.focus();
            setRequest(null);
            Modal.createDialog(
                DesktopFullProfileDialog,
                {
                    client,
                    rightPanelStore: sdk.rightPanelStore,
                    member: current.member,
                    room: current.room,
                    roleSpace: current.roleSpace,
                    isRoomViewed: current.isRoomViewed,
                },
                "mx_Dialog_desktopProfile",
            );
        },
        [client, sdk],
    );

    useEffect(() => {
        const ref = dis.register((payload: ActionPayload) => {
            if (payload.action !== Action.ViewUser) return;
            const { member } = payload as ViewUserPayload;
            if (!member) return;
            const click = lastClick.current;
            const recent = click && Date.now() - click.at < CLICK_ATTRIBUTION_MS ? click.element : undefined;
            const anchor = (recent?.closest(INTERACTIVE) ?? recent) as HTMLElement | undefined;
            const context = resolveContext(member);
            // Without a visible trigger (a slash command, a menu that has already closed) there is nothing to sit
            // beside, so the full profile opens directly.
            if (!anchor?.isConnected) {
                openFull({ member, ...context });
                return;
            }
            // Clicking the same person again closes their card, as it does in Discord.
            if (current.current?.anchor === anchor && current.current.member.userId === member.userId) {
                setRequest(null);
                return;
            }
            setRequest({ member, anchor, ...context });
        });
        return () => dis.unregister(ref);
    }, [resolveContext, openFull]);

    const close = useCallback((restoreFocus = true) => {
        setRequest((current) => {
            if (restoreFocus) current?.anchor.focus();
            return null;
        });
    }, []);

    // Dismiss on Escape and outside clicks; menus opened from the card live in a portal, so they count as inside.
    useEffect(() => {
        if (!request) return;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            // An open menu closes first.
            if (panel.current?.querySelector("[aria-expanded='true']")) return;
            event.preventDefault();
            event.stopPropagation();
            close();
        };
        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (panel.current?.contains(target) || request.anchor.contains(target)) return;
            if (target instanceof Element && target.closest("[role='menu'], [data-radix-popper-content-wrapper]"))
                return;
            close(false);
        };
        const dismissForModal = (): void => setRequest(null);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("pointerdown", onPointerDown);
        Modal.on(ModalManagerEvent.Opened, dismissForModal);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("pointerdown", onPointerDown);
            Modal.off(ModalManagerEvent.Opened, dismissForModal);
        };
    }, [request, close]);

    // Sit beside the trigger and follow it while the page moves.
    useLayoutEffect(() => {
        const element = panel.current;
        if (!request || !element) return;
        const place = (): void => {
            const rect = request.anchor.getBoundingClientRect();
            const card = element.getBoundingClientRect();
            const position = placeProfilePopout(
                { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                { width: card.width, height: card.height },
                { width: UIStore.instance.windowWidth, height: UIStore.instance.windowHeight },
                undefined,
                readWindowControls(),
            );
            element.style.top = `${position.top}px`;
            element.style.left = `${position.left}px`;
            element.style.maxHeight = `${UIStore.instance.windowHeight - 16}px`;
            element.style.visibility = "visible";
        };
        place();
        UIStore.instance.on(UI_EVENTS.Resize, place);
        window.addEventListener("scroll", place, true);
        const observer = new ResizeObserver(place);
        observer.observe(element);
        return () => {
            UIStore.instance.off(UI_EVENTS.Resize, place);
            window.removeEventListener("scroll", place, true);
            observer.disconnect();
        };
    }, [request]);

    // Move focus into the card so the message field can be typed in straight away.
    useEffect(() => {
        const card = panel.current;
        if (request && card)
            (card.querySelector<HTMLElement>("input") ?? card.querySelector<HTMLElement>("button"))?.focus();
    }, [request]);

    if (!request) return null;
    return createPortal(
        <div
            ref={panel}
            id={id}
            role="dialog"
            aria-modal="false"
            aria-label={_t("common|profile")}
            className="mx_DesktopProfilePopout"
            style={{ position: "fixed", zIndex: 100, top: 0, left: 0, visibility: "hidden" }}
        >
            <PopoutCard
                key={request.member.userId}
                request={request}
                onClose={() => close(false)}
                onOpenFull={() => openFull(request)}
            />
        </div>,
        document.body,
    );
}
