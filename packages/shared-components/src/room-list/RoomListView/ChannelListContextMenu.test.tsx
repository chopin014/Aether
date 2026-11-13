/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, type Mock, vi } from "vitest";

import {
    ChannelListContextMenu,
    type ChannelListMenuActions,
    type ChannelListMenuSnapshot,
} from "./ChannelListContextMenu";

const everything: ChannelListMenuSnapshot = {
    hideMutedChannels: false,
    canCreateChannel: true,
    canCreateCategory: true,
    canInvite: true,
};

function renderMenu(menu: ChannelListMenuSnapshot = everything): ReturnType<typeof actions> {
    const handlers = actions();
    render(
        <ChannelListContextMenu menu={menu} actions={handlers}>
            <div data-testid="list">channels</div>
        </ChannelListContextMenu>,
    );
    return handlers;
}

function actions(): { [Action in keyof ChannelListMenuActions]: Mock<() => void> } {
    return {
        toggleHideMutedChannels: vi.fn(),
        createChannel: vi.fn(),
        createCategory: vi.fn(),
        inviteToServer: vi.fn(),
    };
}

describe("<ChannelListContextMenu />", () => {
    it("offers Discord's channel list entries on right click", async () => {
        const user = userEvent.setup();
        const handlers = renderMenu();
        await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("list") });
        expect(screen.getByRole("menuitemcheckbox", { name: "Hide muted channels" })).not.toBeChecked();
        await user.click(screen.getByRole("menuitem", { name: "Create category" }));
        expect(handlers.createCategory).toHaveBeenCalled();
    });

    it.each([
        ["Hide muted channels", "toggleHideMutedChannels", "menuitemcheckbox"],
        ["Create channel", "createChannel", "menuitem"],
        ["Invite to server", "inviteToServer", "menuitem"],
    ] as const)("runs %s", async (name, action, role) => {
        const user = userEvent.setup();
        const handlers = renderMenu();
        await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("list") });
        await user.click(screen.getByRole(role, { name }));
        expect(handlers[action]).toHaveBeenCalled();
    });

    it("shows the hidden state and leaves out what the person may not do", async () => {
        const user = userEvent.setup();
        renderMenu({ hideMutedChannels: true, canCreateChannel: false, canCreateCategory: false, canInvite: false });
        await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("list") });
        expect(screen.getByRole("menuitemcheckbox", { name: "Hide muted channels" })).toBeChecked();
        expect(screen.queryByRole("menuitem")).toBeNull();
        expect(screen.queryByRole("separator")).toBeNull();
    });
});
