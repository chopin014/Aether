/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { Form } from "@vector-im/compound-web";
import React, { type JSX, useCallback, useMemo } from "react";
import { Flex, type VirtualizedListContext, FlatVirtualizedList } from "@element-hq/web-shared-components";

import { SEPARATOR, useMemberListViewModel } from "../../../viewmodels/memberlist/MemberListViewModel";
import { RoomMemberTileView } from "./tiles/RoomMemberTileView";
import { ThreePidInviteTileView } from "./tiles/ThreePidInviteTileView";
import { MemberListHeaderView } from "./MemberListHeaderView";
import BaseCard from "../../right_panel/BaseCard";
import { useFeatureEnabled } from "../../../../hooks/useSettings";
import { _t } from "../../../../languageHandler";
import { useDesktopMemberListViewModel } from "../../../../viewmodels/memberlist/useDesktopMemberListViewModel";
import { isMemberHeading, type DesktopMemberListItem } from "../../../../viewmodels/memberlist/desktopMemberGroups";

interface IProps {
    roomId: string;
    onClose: () => void;
}

/**
 * Height of a single member list item
 */
const MEMBER_LIST_ITEM_HEIGHT = 56;
/** Height of a desktop shell member or presence heading, matching `_DesktopShell.pcss`. */
const DESKTOP_MEMBER_LIST_ITEM_HEIGHT = 48;
type MemberListItem = DesktopMemberListItem;
/**
 * Amount to extend the top and bottom of the viewport by.
 * From manual testing 15 items seems to be enough to never really see the blank space when scrolling.
 */
const EXTENDED_VIEWPORT_HEIGHT = 15 * MEMBER_LIST_ITEM_HEIGHT;

const MemberListView: React.FC<IProps> = (props: IProps) => {
    const vm = useMemberListViewModel(props.roomId);
    const { isPresenceEnabled, memberCount } = vm;
    const desktopShell = useFeatureEnabled("feature_desktop_shell");
    const items = useDesktopMemberListViewModel(props.roomId, vm, desktopShell);
    const memberPositions = useMemo(() => {
        const positions = new Map<MemberListItem, number>();
        for (const item of items) {
            if (item !== SEPARATOR && !isMemberHeading(item)) positions.set(item, positions.size);
        }
        return positions;
    }, [items]);

    const getItemKey = useCallback((item: MemberListItem): string => {
        if (isMemberHeading(item)) return `heading-${item.key}`;
        if (item === SEPARATOR) {
            return "separator";
        } else if (item.member) {
            return `member-${item.member.userId}`;
        } else {
            return `threePidInvite-${item.threePidInvite.event.getStateKey()}`;
        }
    }, []);

    const getItemComponent = useCallback(
        (
            index: number,
            item: MemberListItem,
            context: VirtualizedListContext<unknown>,
            onFocus: (item: MemberListItem, e: React.FocusEvent) => void,
        ): JSX.Element => {
            const itemKey = getItemKey(item);
            // The virtual list initially targets its first row, which is a non-focusable desktop heading.
            const isRovingItem =
                itemKey === context.tabIndexKey ||
                (desktopShell && context.tabIndexKey?.startsWith("heading-") && memberPositions.get(item) === 0);
            const focused = isRovingItem && context.focused;
            if (isMemberHeading(item)) {
                return (
                    <h2 className="mx_MemberListView_groupHeading">
                        {item.heading} — {item.count}
                    </h2>
                );
            }
            if (item === SEPARATOR) {
                return <hr className="mx_MemberListView_separator" />;
            } else if (item.member) {
                return (
                    <RoomMemberTileView
                        item={item}
                        member={item.member}
                        showPresence={isPresenceEnabled}
                        showRole={!desktopShell}
                        focused={focused}
                        tabIndex={isRovingItem ? 0 : -1}
                        index={desktopShell ? memberPositions.get(item)! + (item.member.isInvite ? 1 : 0) : index}
                        memberCount={desktopShell ? memberPositions.size : memberCount}
                        onFocus={onFocus}
                    />
                );
            } else {
                return (
                    <ThreePidInviteTileView
                        item={item}
                        threePidInvite={item.threePidInvite}
                        focused={focused}
                        tabIndex={isRovingItem ? 0 : -1}
                        memberIndex={desktopShell ? memberPositions.get(item)! : index - 1} // Adjust as invites are below the separator
                        memberCount={desktopShell ? memberPositions.size : memberCount}
                        onFocus={onFocus}
                    />
                );
            }
        },
        [isPresenceEnabled, getItemKey, memberCount, desktopShell, memberPositions],
    );

    const isItemFocusable = useCallback((item: MemberListItem): boolean => {
        return item !== SEPARATOR && !isMemberHeading(item);
    }, []);

    return (
        <BaseCard
            id="memberlist-panel"
            className="mx_MemberListView"
            ariaLabelledBy="memberlist-panel-tab"
            role="tabpanel"
            header={desktopShell ? undefined : _t("common|people")}
            hideHeaderButtons={desktopShell}
            onClose={props.onClose}
        >
            <Flex align="stretch" direction="column" className="mx_MemberListView_container">
                {!desktopShell && (
                    <Form.Root onSubmit={(e) => e.preventDefault()}>
                        <MemberListHeaderView vm={vm} />
                    </Form.Root>
                )}
                {desktopShell && vm.isLoading && <span role="status">{_t("common|loading")}</span>}
                <FlatVirtualizedList
                    items={items}
                    getItemComponent={getItemComponent}
                    getItemKey={getItemKey}
                    isItemFocusable={isItemFocusable}
                    role="listbox"
                    aria-label={_t("member_list|list_title")}
                    fixedItemHeight={desktopShell ? DESKTOP_MEMBER_LIST_ITEM_HEIGHT : MEMBER_LIST_ITEM_HEIGHT}
                    increaseViewportBy={{
                        bottom: EXTENDED_VIEWPORT_HEIGHT,
                        top: EXTENDED_VIEWPORT_HEIGHT,
                    }}
                />
            </Flex>
        </BaseCard>
    );
};

export default MemberListView;
