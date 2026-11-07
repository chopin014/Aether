/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { memo, type JSX } from "react";
import { useDragOperation, useDraggable, useDroppable } from "@dnd-kit/react";
import { Feedback } from "@dnd-kit/dom";
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import { useMergeRefs } from "react-merge-refs";

import { RoomListItemView, type RoomListItemViewProps } from "./RoomListItemView";
import { getItemAccessibleProps } from "../../../core/VirtualizedList";
import { useViewModel } from "../../../core/viewmodel";
import { dropSide, isRoomDragData, type RoomDragData, type RoomListDragData, type RoomSlotData } from "../dragAndDrop";

export interface RoomListItemWrapperProps extends RoomListItemViewProps {
    /** Index of this room in the list */
    roomIndex: number;
    /** Index of this room in its section */
    roomIndexInSection: number;
    /** Total number of rooms in the list */
    roomCount: number;
    /** Whether the room list is displayed as a flat list */
    isInFlatList: boolean;
    /**
     * Whether another room can be dropped next to this one, to reorder the rooms of a section whose order the person
     * may change, such as a server category.
     */
    canDropBeside?: boolean;
}

/**
 * Wraps RoomListItemView with the correct accessibility and drag-and-drop props
 * based on whether the list is flat (listbox) or grouped (treegrid).
 */
export const RoomListItemWrapper = memo(function RoomListItemWrapper({
    roomIndex,
    roomCount,
    roomIndexInSection,
    isInFlatList,
    canDropBeside = false,
    ...rest
}: RoomListItemWrapperProps): JSX.Element {
    if (isInFlatList) {
        return <RoomListItemView {...rest} {...getItemAccessibleProps("listbox", roomIndex, roomCount)} />;
    }

    const isFirstInSection = roomIndexInSection === 0;
    return (
        <div {...getItemAccessibleProps("treegrid", roomIndex, roomIndexInSection)}>
            <div role="gridcell" aria-selected={rest.isSelected}>
                <DraggableWrapper
                    {...rest}
                    roomIndex={roomIndex}
                    canDropBeside={canDropBeside}
                    onKeyDown={(e) => {
                        if (e.code === "ArrowLeft" && isFirstInSection) {
                            // Move focus to the section header
                            e.preventDefault();
                            e.stopPropagation();
                            e.currentTarget.dispatchEvent(
                                new KeyboardEvent("keydown", {
                                    code: "ArrowUp",
                                    key: "ArrowUp",
                                    bubbles: true,
                                }),
                            );
                        }
                    }}
                />
            </div>
        </div>
    );
});

/**
 * Wraps RoomListItemView with the drag-and-drop functionality. This is only used for treegrid mode, as flat list items are not draggable.
 */
interface DraggableWrapperProps extends RoomListItemViewProps {
    roomIndex: number;
    canDropBeside: boolean;
}

function DraggableWrapper({ roomIndex, canDropBeside, ...props }: DraggableWrapperProps): JSX.Element {
    const item = useViewModel(props.vm);
    const {
        ref: draggableRef,
        handleRef,
        isDragSource,
    } = useDraggable<RoomDragData>({
        id: item.id,
        data: { type: "room", isDm: item.isDm, index: roomIndex },
        // We clone the item in the dnd overlay to avoid putting a hole in the list
        plugins: [Feedback.configure({ feedback: "clone" })],
        modifiers: [RestrictToVerticalAxis],
        disabled: !item.canChangeSection,
    });

    // Another room can be dropped beside this one to reorder its section, but a direct message never joins a server.
    const { source } = useDragOperation<RoomListDragData>();
    const dragged = source?.data;
    const slot: RoomSlotData = { type: "slot", index: roomIndex };
    const { ref: droppableRef, isDropTarget } = useDroppable<RoomSlotData>({
        id: item.id,
        data: slot,
        disabled: !canDropBeside || isDragSource || !isRoomDragData(dragged) || dragged.isDm,
    });
    const dropIndicator = isDropTarget ? dropSide(dragged, slot) : undefined;

    const dndRef = useMergeRefs([
        ...(item.canChangeSection ? [draggableRef, handleRef] : []),
        ...(canDropBeside ? [droppableRef] : []),
    ]);
    // Only wire up the draggable refs when the room can be dragged, otherwise dndkit puts incorrect
    // and misleading a11y attributes on the item (aria-disabled=true and aria-draggable=false)
    return (
        <RoomListItemView
            {...props}
            ref={item.canChangeSection || canDropBeside ? dndRef : undefined}
            isDragSource={isDragSource}
            dropIndicator={dropIndicator}
        />
    );
}
