/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@vector-im/compound-web";
import { getByRole, getByTestId, queryByRole } from "@testing-library/dom";

import "@vector-im/compound-design-tokens/assets/web/css/compound-design-tokens.css";
import "@vector-im/compound-web/dist/style.css";
// Import source views so the layout test uses current CSS modules without a separate package build.
/* oxlint-disable no-restricted-imports */
import { Flex } from "../../../../../../../packages/shared-components/src/core/utils/Flex";
import { I18nContext } from "../../../../../../../packages/shared-components/src/core/i18n/i18nContext";
import { MockViewModel } from "../../../../../../../packages/shared-components/src/core/viewmodel/MockViewModel";
import { RoomListHeaderView } from "../../../../../../../packages/shared-components/src/room-list/RoomListHeaderView/RoomListHeaderView";
import {
    MockedViewModel as HeaderViewModel,
    defaultSnapshot as headerSnapshot,
} from "../../../../../../../packages/shared-components/src/room-list/RoomListHeaderView/test-utils";
import {
    RoomListView,
    type RoomListViewModel,
    type RoomListViewSnapshot,
} from "../../../../../../../packages/shared-components/src/room-list/RoomListView/RoomListView";
import {
    createGetRoomItemViewModel,
    createGetSectionHeaderViewModel,
} from "../../../../../../../packages/shared-components/src/room-list/story-mocks";
/* oxlint-enable no-restricted-imports */
import desktopShellCss from "../../../../../res/css/structures/_DesktopShell.pcss?raw";
import roomListPanelCss from "../../../../../res/css/views/rooms/RoomListPanel/_RoomListPanel.pcss?raw";

// Translation loading is unrelated to geometry and depends on Node globals in this browser runner.
vi.mock("../../../../../../../packages/shared-components/src/core/i18n/i18n", () => ({
    _t: (key: string) => key,
    _td: (key: string) => key,
}));

const i18n = {
    language: "en",
    translate: (key: string): string => key,
    register: vi.fn<() => void>(),
    humanizeTime: vi.fn<() => string>(),
};

describe("Desktop channel list spacing", () => {
    let container: HTMLDivElement;
    let stylesheet: HTMLStyleElement;
    let root: Root;

    beforeEach(() => {
        stylesheet = document.createElement("style");
        // Match the app's reset and desktop ancestor while exercising the real shared views and scroller.
        stylesheet.textContent = `* { box-sizing: border-box; } ${roomListPanelCss} ${desktopShellCss}`;
        document.head.appendChild(stylesheet);
        document.body.classList.add("mx_DesktopShell", "cpd-theme-dark");
        container = document.createElement("div");
        container.className = "mx_MatrixChat_wrapper mx_MatrixChat_desktopShell";
        container.style.width = "310px";
        container.style.height = "500px";
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
        stylesheet.remove();
        document.body.classList.remove("mx_DesktopShell", "cpd-theme-dark");
        document.body.style.removeProperty("--mx-desktop-dock-height");
    });

    const renderList = (collapsed = false, dockHeight = 56, desktop = true): void => {
        container.classList.toggle("mx_MatrixChat_desktopShell", desktop);
        document.body.style.setProperty("--mx-desktop-dock-height", `${dockHeight}px`);
        const roomIds = Array.from({ length: 30 }, (_, i) => `!room${i}:example.org`);
        const sections = [
            { id: "text Channels", roomIds: collapsed ? [] : roomIds.slice(0, 2) },
            { id: "voz", roomIds: roomIds.slice(2) },
        ];
        const getSectionHeaderViewModel = createGetSectionHeaderViewModel(sections.map(({ id }) => id));
        const firstHeader = getSectionHeaderViewModel(sections[0].id);
        const firstSnapshot = { ...firstHeader.getSnapshot(), isExpanded: !collapsed };
        firstHeader.getSnapshot = () => firstSnapshot;
        const snapshot: RoomListViewSnapshot = {
            isLoadingRooms: false,
            isRoomListEmpty: false,
            filterIds: [],
            hidePrimaryFilters: true,
            isFlatList: false,
            roomListState: { spaceId: "!space:example.org" },
            sections,
        };
        const getRoomItemViewModel = createGetRoomItemViewModel(roomIds);
        roomIds.forEach((id, index) => {
            const roomVm = getRoomItemViewModel(id);
            const roomSnapshot = {
                ...roomVm.getSnapshot(),
                name: `Channel ${index}`,
                channelKind: index < 2 ? ("text" as const) : ("voice" as const),
                showMoreOptionsMenu: false,
                showNotificationMenu: false,
            };
            roomVm.getSnapshot = () => roomSnapshot;
        });
        const vm: RoomListViewModel = Object.assign(new MockViewModel(snapshot), {
            getRoomItemViewModel,
            getSectionHeaderViewModel,
            onToggleFilter: vi.fn<() => void>(),
            createChatRoom: vi.fn<() => void>(),
            createRoom: vi.fn<() => void>(),
            updateVisibleRooms: vi.fn<() => void>(),
            updateVisibleFold: vi.fn<() => void>(),
            closeToast: vi.fn<() => void>(),
            scrollToUnreadActivity: vi.fn<() => void>(),
            setScrollToIndex: vi.fn<() => void>(),
            changeRoomSection: vi.fn<() => void>(),
            changeSectionOrder: vi.fn<() => void>(),
            onSectionOrRoomDragStart: vi.fn<() => void>(),
            onSectionOrRoomDragEnd: vi.fn<() => void>(),
        });
        const headerVm = new HeaderViewModel({ ...headerSnapshot, title: "Terra do boi gordo" });

        flushSync(() =>
            root.render(
                <TooltipProvider>
                    <I18nContext.Provider value={i18n}>
                        <Flex
                            as="nav"
                            className="mx_RoomListPanel"
                            direction="column"
                            align="stretch"
                            aria-label="Channels"
                        >
                            <RoomListHeaderView vm={headerVm} desktop />
                            <RoomListView vm={vm} renderAvatar={() => null} />
                        </Flex>
                    </I18nContext.Provider>
                </TooltipProvider>,
            ),
        );
    };

    it.each([false, true])("should inset the first category with collapsed=%s", async (collapsed) => {
        renderList(collapsed);
        const header = getByTestId(container, "room-list-header");
        await expect.poll(() => queryByRole(container, "row", { name: /Text Channels/ })).toBeTruthy();
        const section = getByRole(container, "row", { name: /Text Channels/ });

        expect(section.getBoundingClientRect().top - header.getBoundingClientRect().bottom).toBe(16);
        expect(getByRole(container, "row", { name: /Voz/ }).getBoundingClientRect().top).toBeGreaterThanOrEqual(
            section.getBoundingClientRect().bottom,
        );
    });

    it.each([56, 144])("should retain scrolling and clearance for a %spx account/call dock", async (dockHeight) => {
        renderList(false, dockHeight);
        const panel = getByRole(container, "navigation", { name: "Channels" });
        await expect.poll(() => queryByRole(container, "treegrid")).toBeTruthy();
        const scroller = getByRole(container, "treegrid");
        const header = getByTestId(container, "room-list-header");
        const headerTop = header.getBoundingClientRect().top;
        expect(scroller.clientHeight).toBeGreaterThan(200);

        expect(panel.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom).toBe(dockHeight + 16);
        await expect.poll(() => scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
        const firstRow = getByRole(container, "row", { name: /Channel 0\b/ });
        const secondRow = getByRole(container, "row", { name: /Channel 1\b/ });
        const rowHeight = firstRow.getBoundingClientRect().height;
        expect(rowHeight).toBe(38);
        expect(secondRow.getBoundingClientRect().top - firstRow.getBoundingClientRect().bottom).toBe(0);
        scroller.scrollTop = scroller.scrollHeight;
        await expect.poll(() => scroller.scrollTop).toBeGreaterThan(0);
        expect(header.getBoundingClientRect().top).toBe(headerTop);
        expect(firstRow.getBoundingClientRect().height).toBe(rowHeight);
    });

    it("should leave the web presentation flush below the header", async () => {
        renderList(false, 56, false);
        await expect.poll(() => queryByRole(container, "row", { name: /Text Channels/ })).toBeTruthy();
        const header = getByTestId(container, "room-list-header");
        const section = getByRole(container, "row", { name: /Text Channels/ });

        expect(section.getBoundingClientRect().top).toBe(header.getBoundingClientRect().bottom);
    });
});
