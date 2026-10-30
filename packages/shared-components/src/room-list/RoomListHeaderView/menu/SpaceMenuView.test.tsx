/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, afterEach, expect } from "vitest";

import { SpaceMenuView } from "./SpaceMenuView";
import { defaultSnapshot, MockedViewModel } from "../test-utils";

describe("<SpaceMenuView />", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("should match snapshot", () => {
        const vm = new MockedViewModel(defaultSnapshot);
        const { asFragment } = render(<SpaceMenuView vm={vm} />);

        expect(asFragment()).toMatchSnapshot();
    });

    it("should display the menu when button is clicked", async () => {
        const user = userEvent.setup();

        const vm = new MockedViewModel(defaultSnapshot);
        render(<SpaceMenuView vm={vm} />);

        const button = screen.getByRole("button", { name: "Open server menu" });
        await user.click(button);

        expect(screen.getByRole("menuitem", { name: "Server home" })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Invite" })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Preferences" })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Server settings" })).toBeInTheDocument();
    });

    it("should hide invite option when canInviteInSpace is false", async () => {
        const user = userEvent.setup();

        const vm = new MockedViewModel({ ...defaultSnapshot, canInviteInSpace: false });
        render(<SpaceMenuView vm={vm} />);

        const button = screen.getByRole("button", { name: "Open server menu" });
        await user.click(button);

        expect(screen.queryByRole("menuitem", { name: "Invite" })).not.toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Server home" })).toBeInTheDocument();
    });

    it("should hide space settings option when canAccessSpaceSettings is false", async () => {
        const user = userEvent.setup();

        const vm = new MockedViewModel({ ...defaultSnapshot, canAccessSpaceSettings: false });
        render(<SpaceMenuView vm={vm} />);

        const button = screen.getByRole("button", { name: "Open server menu" });
        await user.click(button);

        expect(screen.queryByRole("menuitem", { name: "Server settings" })).not.toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Server home" })).toBeInTheDocument();
    });

    it("should call openSpaceHome when Home is clicked", async () => {
        const user = userEvent.setup();

        const vm = new MockedViewModel(defaultSnapshot);
        render(<SpaceMenuView vm={vm} />);

        await user.click(screen.getByRole("button", { name: "Open server menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Server home" }));

        expect(vm.openSpaceHome).toHaveBeenCalledTimes(1);
    });

    it("should call inviteInSpace when Invite is clicked", async () => {
        const user = userEvent.setup();

        const vm = new MockedViewModel(defaultSnapshot);
        render(<SpaceMenuView vm={vm} />);

        await user.click(screen.getByRole("button", { name: "Open server menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Invite" }));

        expect(vm.inviteInSpace).toHaveBeenCalledTimes(1);
    });

    it("should call openSpacePreferences when Preferences is clicked", async () => {
        const user = userEvent.setup();

        const vm = new MockedViewModel(defaultSnapshot);
        render(<SpaceMenuView vm={vm} />);

        await user.click(screen.getByRole("button", { name: "Open server menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Preferences" }));

        expect(vm.openSpacePreferences).toHaveBeenCalledTimes(1);
    });

    it("should call openSpaceSettings when Server settings is clicked", async () => {
        const user = userEvent.setup();

        const vm = new MockedViewModel(defaultSnapshot);
        render(<SpaceMenuView vm={vm} />);

        await user.click(screen.getByRole("button", { name: "Open server menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Server settings" }));

        expect(vm.openSpaceSettings).toHaveBeenCalledTimes(1);
    });

    it("should group desktop actions without repeating the server title", async () => {
        const vm = new MockedViewModel({ ...defaultSnapshot, title: "Terra do boi gordo" });
        render(<SpaceMenuView vm={vm} fullWidth />);
        const trigger = screen.getByRole("button", { name: "Open server menu" });
        expect(trigger).toHaveAccessibleDescription("Terra do boi gordo");
        await userEvent.click(trigger);

        const menu = screen.getByRole("menu");
        expect(menu).toHaveAttribute("aria-label", "Terra do boi gordo");
        expect(menu).not.toHaveTextContent("Terra do boi gordo");
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
            "Invite",
            "Server home",
            "New room",
            "New voice room",
            "Preferences",
            "Server settings",
        ]);
        for (const item of screen.getAllByRole("menuitem")) {
            expect(item.querySelector("svg[aria-hidden=true]")).not.toBeNull();
        }
    });

    it.each([
        ["New room", "createRoom"],
        ["New voice room", "createVideoRoom"],
        ["Invite", "inviteInSpace"],
        ["Server home", "openSpaceHome"],
        ["Preferences", "openSpacePreferences"],
        ["Server settings", "openSpaceSettings"],
    ] as const)("should select and dismiss the desktop %s action", async (label, action) => {
        const vm = new MockedViewModel(defaultSnapshot);
        render(<SpaceMenuView vm={vm} fullWidth />);
        const trigger = screen.getByRole("button", { name: "Open server menu" });
        await userEvent.click(trigger);
        await userEvent.click(screen.getByRole("menuitem", { name: label }));

        expect(vm[action]).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    it.each([
        { canCreateRoom: false, canCreateVideoRoom: false },
        { canCreateRoom: true, canCreateVideoRoom: false },
        { canCreateRoom: false, canCreateVideoRoom: true },
    ])("should preserve desktop creation permissions: %j", async (permissions) => {
        const vm = new MockedViewModel({
            ...defaultSnapshot,
            ...permissions,
            canInviteInSpace: false,
            canAccessSpaceSettings: false,
        });
        render(<SpaceMenuView vm={vm} fullWidth />);
        await userEvent.click(screen.getByRole("button", { name: "Open server menu" }));

        expect(!!screen.queryByRole("menuitem", { name: "New room" })).toBe(permissions.canCreateRoom);
        expect(!!screen.queryByRole("menuitem", { name: "New voice room" })).toBe(permissions.canCreateVideoRoom);
        expect(screen.queryByRole("menuitem", { name: "Invite" })).not.toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: "Server settings" })).not.toBeInTheDocument();
        const separators = screen.getByRole("menu").querySelectorAll("[data-orientation=horizontal]");
        expect(separators).toHaveLength(permissions.canCreateRoom || permissions.canCreateVideoRoom ? 2 : 1);
    });
});
