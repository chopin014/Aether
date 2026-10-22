/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { Form } from "@vector-im/compound-web";
import React, { type JSX, useCallback, useMemo } from "react";
import { Flex, type VirtualizedListContext, FlatVirtualizedList } from "@element-hq/web-shared-components";

import {
    type MemberWithSeparator,
    SEPARATOR,
    useMemberListViewModel,
} from "../../../viewmodels/memberlist/MemberListViewModel";
import { RoomMemberTileView } from "./tiles/RoomMemberTileView";
import { ThreePidInviteTileView } from "./tiles/ThreePidInviteTileView";
import { MemberListHeaderView } from "./MemberListHeaderView";
import BaseCard from "../../right_panel/BaseCard";
import { useFeatureEnabled } from "../../../../hooks/useSettings";
import { _t } from "../../../../languageHandler";

interface IProps {
    roomId: string;
    onClose: () => void;
}

/**
 * Height of a single member list item
 */
const MEMBER_LIST_ITEM_HEIGHT = 56;
type MemberListItem = MemberWithSeparator | { heading: string; count: number; key: string };
const isHeading = (item: MemberListItem): item is { heading: string; count: number; key: string } =>
    typeof item === "object" && "heading" in item;
/**
 * Amount to extend the top and bottom of the viewport by.
 * From manual testing 15 items seems to be enough to never really see the blank space when scrolling.
 */
const EXTENDED_VIEWPORT_HEIGHT = 15 * MEMBER_LIST_ITEM_HEIGHT;

const MemberListView: React.FC<IProps> = (props: IProps) => {
    const vm = useMemberListViewModel(props.roomId);
    const { isPresenceEnabled, memberCount } = vm;
    const desktopShell = useFeatureEnabled("feature_desktop_shell");
    const items = useMemo<MemberListItem[]>(() => {
        if (!desktopShell) return vm.members;
        const joined = vm.members.filter((item) => item !== SEPARATOR && item.member && !item.member.isInvite);
        const invitations = vm.members.filter((item) => item !== SEPARATOR && (!item.member || item.member.isInvite));
        const groups: { key: string; heading: string; members: MemberWithSeparator[] }[] = [];
        if (isPresenceEnabled) {
            const online = joined.filter(
                (item) => item !== SEPARATOR && ["online", "unavailable"].includes(item.member?.presenceState ?? ""),
            );
            const onlineIds = new Set(online);
            groups.push({ key: "online", heading: _t("desktop|contacts|online"), members: online });
            groups.push({
                key: "offline",
                heading: _t("desktop|contacts|offline"),
                members: joined.filter((item) => !onlineIds.has(item)),
            });
        } else {
            groups.push({ key: "members", heading: _t("member_list|list_title"), members: joined });
        }
        groups.push({ key: "invited", heading: _t("desktop|members|invited"), members: invitations });
        return groups.flatMap(({ key, heading, members }) =>
            members.length ? [{ key, heading, count: members.length }, ...members] : [],
        );
    }, [desktopShell, vm.members, isPresenceEnabled]);

    const getItemKey = useCallback((item: MemberListItem): string => {
        if (isHeading(item)) return `heading-${item.key}`;
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
            context: VirtualizedListContext<any>,
            onFocus: (item: MemberListItem, e: React.FocusEvent) => void,
        ): JSX.Element => {
            const itemKey = getItemKey(item);
            const isRovingItem = itemKey === context.tabIndexKey;
            const focused = isRovingItem && context.focused;
            if (isHeading(item)) {
                return (
                    <h2 className="mx_DesktopShell_memberHeading">
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
                        focused={focused}
                        tabIndex={isRovingItem ? 0 : -1}
                        index={desktopShell ? vm.members.indexOf(item) : index}
                        memberCount={memberCount}
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
                        memberIndex={desktopShell ? vm.members.indexOf(item) - 1 : index - 1} // Adjust as invites are below the separator
                        memberCount={memberCount}
                        onFocus={onFocus}
                    />
                );
            }
        },
        [isPresenceEnabled, getItemKey, memberCount, desktopShell, vm.members],
    );

    const isItemFocusable = useCallback((item: MemberListItem): boolean => {
        return item !== SEPARATOR && !isHeading(item);
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
                    fixedItemHeight={desktopShell ? 44 : MEMBER_LIST_ITEM_HEIGHT}
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
