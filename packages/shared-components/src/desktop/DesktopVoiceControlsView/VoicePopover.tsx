/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Heading, IconButton } from "@vector-im/compound-web";
import { CloseIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopVoiceControlsView.module.css";

interface VoicePopoverProps {
    /** The button above which the panel opens and to which Escape returns focus. */
    anchor: RefObject<HTMLButtonElement | null>;
    title: string;
    onClose: () => void;
    children: ReactNode;
}

/** A viewport-bounded call panel, portalled out of the dock's clipping and stacking contexts. */
export function VoicePopover({ anchor, title, onClose, children }: VoicePopoverProps): JSX.Element {
    const { translate: _t } = useI18n();
    const titleId = useId();
    const panel = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ left: 0, top: 0 });
    useLayoutEffect(() => {
        const trigger = anchor.current;
        const updatePosition = (): void => {
            if (!trigger || !panel.current) return;
            const rect = trigger.getBoundingClientRect();
            const { width, height } = panel.current.getBoundingClientRect();
            const gutter = 12;
            setPosition({
                left: Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter)),
                top: Math.max(gutter, Math.min(rect.top - height - gutter, window.innerHeight - height - gutter)),
            });
        };
        updatePosition();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
        if (panel.current) observer?.observe(panel.current);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        const element = panel.current;
        let returnFocus = true;
        element?.focus();
        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target;
            if (target instanceof Node && !panel.current?.contains(target) && !trigger?.contains(target)) {
                returnFocus = false;
                onClose();
            }
        };
        const onFocusIn = (event: FocusEvent): void => {
            const target = event.target;
            if (target instanceof Node && !element?.contains(target) && !trigger?.contains(target)) {
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
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("focusin", onFocusIn);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("keydown", onKeyDown, true);
            // Closing through the close button returns focus without stealing focus from an outside click.
            if (returnFocus && element?.contains(document.activeElement)) {
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
            className={styles.popover}
            style={{ left: position.left, top: position.top }}
        >
            <div className={styles.panelHeader}>
                <Heading as="h2" size="sm" weight="semibold" id={titleId}>
                    {title}
                </Heading>
                <IconButton tooltip={_t("action|close")} onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </div>
            {children}
        </div>,
        document.body,
    );
}
