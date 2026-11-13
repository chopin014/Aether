/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useEffect, useState } from "react";
import { Separator } from "react-resizable-panels";
import DragIcon from "@vector-im/compound-design-tokens/assets/web/icons/drag-list";
import classNames from "classnames";
import { Tooltip } from "@vector-im/compound-web";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import styles from "./SeparatorView.module.css";
import { type ResizerViewSnapshot } from "..";
import { useI18n } from "../../core/i18n/i18nContext";

export interface SeparatorViewActions {
    /**
     * onPointerUp handler for separator.
     */
    onPointerUp: () => void;

    /**
     * onPointerMove handler for separator. Takes the event so that how far the pointer has travelled
     * since it went down can be measured.
     */
    onPointerMove: (event: React.PointerEvent) => void;

    /**
     * onPointerDown handler for separator. Takes the event so that where the pointer went down can be
     * measured from.
     */
    onPointerDown: (event: React.PointerEvent) => void;

    /**
     * onDoubleClick handler for the separator.
     */
    onDoubleClick: () => void;

    /**
     * Called when a drag of the separator starts, with true, and when it ends, with false.
     */
    onDraggingChange: (isDragging: boolean) => void;
}

interface Props {
    vm: ViewModel<ResizerViewSnapshot, SeparatorViewActions>;
    className?: string;
}

/**
 * Custom separator for collapsible left-panel based on {@link Separator}.
 */
export function SeparatorView({ vm, className }: Props): React.ReactNode {
    const { translate: _t } = useI18n();
    const { isCollapsed } = useViewModel(vm);
    const watchDragging = useDraggingWatcher(vm.onDraggingChange);

    /**
     * There are two types of separator:
     * - bar: This shows a thick bar separator with a resize icon in the middle; shown when the panel is collapsed.
     * - border: This is just a thin separator; shown when the panel is expanded.
     */
    const type = isCollapsed ? "bar" : "border";

    const barContent = (
        <Tooltip description={_t("left_panel|separator_label")} placement="right" disabled={type === "border"}>
            <div className={styles.content}>
                <DragIcon
                    className={styles.dragIcon}
                    width="20px"
                    height="12px"
                    // Without a custom view-box, this svg would scale incorrectly and would appear tiny within the separator.
                    // See https://github.com/element-hq/compound/issues/242
                    viewBox="3.999704360961914 8.999704360961914 16.000295639038086 6.000591278076172"
                    transform="rotate(90)"
                />
            </div>
        </Tooltip>
    );

    /**
     * This border is:
     * - a 1px border that separates the left panel and main content.
     * - a 2px border when the panel is expanded and the user is interacting with the separator.
     */
    const border = (
        <div className={styles.activeSeparatorContainer}>
            <div className={styles.activeSeparator} />
        </div>
    );

    return (
        <Separator
            elementRef={watchDragging}
            className={classNames(styles.separator, className)}
            onPointerUp={vm.onPointerUp}
            onPointerMove={vm.onPointerMove}
            onPointerDown={vm.onPointerDown}
            aria-label={_t("left_panel|separator_label")}
            data-separator-type={type}
            onDoubleClick={vm.onDoubleClick}
            disableDoubleClick
        >
            {type === "bar" ? barContent : border}
        </Separator>
    );
}

/**
 * Returns a ref for the separator's element, and calls `onDraggingChange` as a drag of that element starts and ends.
 *
 * react-resizable-panels shows that the separator is being dragged only through its `data-separator` attribute,
 * which it sets to "active" for the length of the drag, so this watches that attribute. The library keeps the first
 * ref it is given, so the watching follows the element and the callback in an effect rather than in the ref. A new
 * callback during a drag hears it start as the old one hears it end; a separator removed during a drag ends it.
 */
function useDraggingWatcher(onDraggingChange: (isDragging: boolean) => void): (element: HTMLDivElement | null) => void {
    const [element, setElement] = useState<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!element) return;
        let dragging = false;
        const update = (): void => {
            const now = element.getAttribute("data-separator") === "active";
            if (now === dragging) return;
            dragging = now;
            onDraggingChange(now);
        };
        const observer = new MutationObserver(update);
        observer.observe(element, { attributes: true, attributeFilter: ["data-separator"] });
        update();
        return (): void => {
            observer.disconnect();
            if (dragging) onDraggingChange(false);
        };
    }, [element, onDraggingChange]);

    return setElement;
}
