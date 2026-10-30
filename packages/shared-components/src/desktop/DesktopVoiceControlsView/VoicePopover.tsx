/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import classNames from "classnames";
import { Heading, IconButton } from "@vector-im/compound-web";
import { CloseIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopVoiceControlsView.module.css";

interface VoicePopoverProps {
    /** The button above which the panel opens and to which Escape returns focus. */
    anchor: RefObject<HTMLButtonElement | null>;
    title: string;
    onClose: () => void;
    /** A narrower panel, for the short device menus. */
    compact?: boolean;
    /** A self-contained picker that provides its own heading and dimensions. */
    contentOnly?: boolean;
    children: ReactNode;
}

/** A viewport-bounded call panel, portalled out of the dock's clipping and stacking contexts. */
export function VoicePopover({
    anchor,
    title,
    onClose,
    compact,
    contentOnly,
    children,
}: VoicePopoverProps): JSX.Element {
    const { translate: _t } = useI18n();
    const titleId = useId();
    const panel = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ left: 0, top: 0 });
    useLayoutEffect(() => {
        const trigger = anchor.current;
        const ownerDocument = trigger?.ownerDocument ?? document;
        const ownerWindow = ownerDocument.defaultView ?? window;
        const updatePosition = (): void => {
            if (!trigger || !panel.current) return;
            const rect = trigger.getBoundingClientRect();
            const { width, height } = panel.current.getBoundingClientRect();
            const gutter = 12;
            setPosition({
                left: Math.max(gutter, Math.min(rect.left, ownerWindow.innerWidth - width - gutter)),
                top: Math.max(gutter, Math.min(rect.top - height - gutter, ownerWindow.innerHeight - height - gutter)),
            });
        };
        updatePosition();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
        if (panel.current) observer?.observe(panel.current);
        ownerWindow.addEventListener("resize", updatePosition);
        ownerWindow.addEventListener("scroll", updatePosition, true);
        const element = panel.current;
        let returnFocus = true;
        let filePickerOpen = false;
        element?.focus();
        const onFilePickerOpen = (event: Event): void => {
            if (event.target instanceof HTMLInputElement && event.target.type === "file") filePickerOpen = true;
        };
        const onFilePickerFinished = (event: Event): void => {
            if (!(event.target instanceof HTMLInputElement) || event.target.type !== "file") return;
            filePickerOpen = false;
            // Keep focus inside before the form disables its file input to decode the selected audio.
            element?.focus({ preventScroll: true });
        };
        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target;
            if (target && !panel.current?.contains(target as Node) && !trigger?.contains(target as Node)) {
                returnFocus = false;
                onClose();
            }
        };
        const onFocusIn = (event: FocusEvent): void => {
            // Native file dialogs can briefly restore focus to the page behind this panel.
            if (filePickerOpen) return;
            const target = event.target;
            if (target && !element?.contains(target as Node) && !trigger?.contains(target as Node)) {
                returnFocus = false;
                onClose();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
            trigger?.focus();
        };
        ownerDocument.addEventListener("pointerdown", onPointerDown);
        ownerDocument.addEventListener("focusin", onFocusIn);
        ownerDocument.addEventListener("keydown", onKeyDown, true);
        element?.addEventListener("click", onFilePickerOpen, true);
        element?.addEventListener("change", onFilePickerFinished, true);
        element?.addEventListener("cancel", onFilePickerFinished, true);
        return () => {
            observer?.disconnect();
            ownerWindow.removeEventListener("resize", updatePosition);
            ownerWindow.removeEventListener("scroll", updatePosition, true);
            ownerDocument.removeEventListener("pointerdown", onPointerDown);
            ownerDocument.removeEventListener("focusin", onFocusIn);
            ownerDocument.removeEventListener("keydown", onKeyDown, true);
            element?.removeEventListener("click", onFilePickerOpen, true);
            element?.removeEventListener("change", onFilePickerFinished, true);
            element?.removeEventListener("cancel", onFilePickerFinished, true);
            // Closing through the close button returns focus without stealing focus from an outside click.
            if (returnFocus && element?.contains(ownerDocument.activeElement)) {
                trigger?.focus();
            }
        };
    }, [anchor, onClose]);
    return createPortal(
        <div
            ref={panel}
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={classNames(
                styles.popover,
                compact && styles.compactPopover,
                contentOnly && styles.contentPopover,
            )}
            style={{ left: position.left, top: position.top }}
        >
            <div className={contentOnly ? styles.visuallyHidden : styles.panelHeader}>
                <Heading as="h2" size="sm" weight="semibold" id={titleId}>
                    {title}
                </Heading>
                {!contentOnly && (
                    <IconButton tooltip={_t("action|close")} onClick={onClose}>
                        <CloseIcon />
                    </IconButton>
                )}
            </div>
            {children}
        </div>,
        anchor.current?.ownerDocument.body ?? document.body,
    );
}
