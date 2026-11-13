/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type CSSProperties, type ReactNode } from "react";
import { type MatrixEvent } from "matrix-js-sdk/src/matrix";

import { BaseGrouper } from "./BaseGrouper";
import { SeparatorKind, type WrappedEvent } from "../MessagePanel";
import type MessagePanel from "../MessagePanel";
import SettingsStore from "../../../settings/SettingsStore";
import { GALLERY_WINDOW_MS, galleryColumns, isGalleryMedia } from "../../../utils/gallery";

/**
 * Lays out pictures one person sends together the way they were sent: the first, with any text sent alongside, as a
 * normal message, and the rest as a grid of tiles beneath it rather than a tall stack.
 *
 * Each picture stays its own event with its own actions and reactions; only the layout changes, and only in the
 * desktop shell.
 */
export class GalleryGrouper extends BaseGrouper {
    public static canStartGroup = function (_panel: MessagePanel, { event, shouldShow }: WrappedEvent): boolean {
        return !!shouldShow && SettingsStore.getValue("feature_desktop_shell") && isGalleryMedia(event, true);
    };

    /** The last picture in the gallery so far. */
    private get lastEvent(): MatrixEvent {
        return (this.events.at(-1) ?? this.firstEventAndShouldShow).event;
    }

    public shouldGroup({ event, shouldShow }: WrappedEvent): boolean {
        // Hidden events, such as edits and reactions, render nothing and don't break the run.
        if (!shouldShow) return true;
        const last = this.lastEvent;
        return (
            isGalleryMedia(event, false) &&
            event.getSender() === last.getSender() &&
            event.getTs() - last.getTs() <= GALLERY_WINDOW_MS &&
            this.panel.wantsSeparator(last, event) === SeparatorKind.None
        );
    }

    public add(wrappedEvent: WrappedEvent): void {
        const { event, shouldShow } = wrappedEvent;
        this.readMarker =
            this.readMarker || this.panel.readMarkerForEvent(event.getId()!, event === this.lastShownEvent);
        if (shouldShow) this.events.push(wrappedEvent);
    }

    public getTiles(): ReactNode[] {
        const panel = this.panel;
        const all = [this.firstEventAndShouldShow, ...this.events];
        const ret: ReactNode[] = [];
        const nextAfter = (index: number): WrappedEvent | null => all[index + 1] ?? this.nextEvent;
        const nextTileAfter = (index: number): MatrixEvent | null =>
            all[index + 1]?.event ?? this.nextEventTile ?? null;

        // The first picture is an ordinary message: date separator, sender and any text sent with the pictures.
        ret.push(
            ...panel.getTilesForEvent(
                this.prevEvent,
                all[0],
                all[0].event === this.lastShownEvent,
                false,
                nextAfter(0),
                nextTileAfter(0),
            ),
        );

        const rest = all.slice(1);
        if (rest.length > 0) {
            const tiles = rest.flatMap((wrapped, index) =>
                panel.getTilesForEvent(
                    all[index].event,
                    wrapped,
                    wrapped.event === this.lastShownEvent,
                    true,
                    nextAfter(index + 1),
                    nextTileAfter(index + 1),
                ),
            );
            const columns = galleryColumns(rest.length);
            const style = { "--mx-desktop-gallery-columns": columns } as CSSProperties;
            ret.push(
                <li
                    key={`gallery-${rest[0].event.getId()}`}
                    className="mx_DesktopGallery"
                    // The scroll panel only tracks its direct children, so the gallery stands in for its pictures.
                    data-scroll-tokens={rest.map((wrapped) => wrapped.event.getId()).join(",")}
                >
                    <ol className="mx_DesktopGallery_list" style={style} data-columns={columns}>
                        {tiles}
                    </ol>
                </li>,
            );
        }

        if (this.readMarker) ret.push(this.readMarker);
        return ret;
    }

    public getNewPrevEvent(): MatrixEvent {
        return this.lastEvent;
    }
}
