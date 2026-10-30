/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { composeStories } from "@storybook/react-vite";
import { render, screen } from "@test-utils";
import { describe, it, expect } from "vitest";
import React from "react";

import userEvent from "@testing-library/user-event";
import { RoomListHeaderView } from "./RoomListHeaderView";
import { MockedViewModel, defaultSnapshot } from "./test-utils";

import * as stories from "./RoomListHeaderView.stories";

const { Default, NoSpaceMenu, CollapseSections, ExpandSections } = composeStories(stories);

describe("RoomListHeaderView", () => {
    it("renders the default state", () => {
        const { container } = render(<Default />);
        expect(container).toMatchSnapshot();
    });

    it("renders without space menu", () => {
        const { container } = render(<NoSpaceMenu />);
        expect(container).toMatchSnapshot();
    });

    it("renders collapse button", () => {
        const { container } = render(<CollapseSections />);
        expect(container).toMatchSnapshot();
    });

    it("renders expand button", () => {
        const { container } = render(<ExpandSections />);
        expect(container).toMatchSnapshot();
    });

    it("should bind the collapse all sections action", () => {
        const { getByRole } = render(<CollapseSections />);
        const collapseButton = getByRole("button", { name: "Collapse all sections" });
        collapseButton.click();
        expect(CollapseSections.args?.collapseOrExpandSections).toHaveBeenCalled();
    });
});

it("opens the Space menu from the whole desktop title and retains permission-checked creation", async () => {
    const vm = new MockedViewModel({
        ...defaultSnapshot,
        title: "Design studio",
        displaySpaceMenu: true,
        canCreateRoom: true,
        canCreateVideoRoom: false,
    });
    render(<RoomListHeaderView vm={vm} desktop />);
    const title = screen.getByRole("button", { name: "Open server menu" });
    expect(title).toHaveTextContent("Design studio");
    await userEvent.click(title);
    expect(screen.queryByRole("menuitem", { name: "New voice room" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "New room" }));
    expect(vm.createRoom).toHaveBeenCalledOnce();
});
