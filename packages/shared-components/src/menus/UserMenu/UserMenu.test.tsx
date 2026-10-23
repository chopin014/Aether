/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { composeStories } from "@storybook/react-vite";
import { render } from "@test-utils";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { MockViewModel } from "../../core/viewmodel";
import { type PresenceSnapshot } from "../../presence/PresenceMenuView";

import * as stories from "./UserMenu.stories.tsx";

const { Default, LongerName, Condensed, Guest, Open, NoAvatar, WithStatus, WithStatusOpen } = composeStories(stories);

describe("UserMenu", () => {
    it("renders a button", async () => {
        const { container } = render(<Default />);
        expect(container).toMatchSnapshot();
    });
    it("renders a button with a longer name", async () => {
        const { container } = render(<LongerName />);
        expect(container).toMatchSnapshot();
    });
    it("renders condensed view", async () => {
        const { container } = render(<Condensed />);
        expect(container).toMatchSnapshot();
    });
    it("renders the status emoji when set", async () => {
        const { container } = render(<WithStatus />);
        expect(container).toMatchSnapshot();
    });
    it("renders a menu", async () => {
        const { baseElement, getByRole } = render(<Default />);
        await userEvent.click(getByRole("button"));
        expect(baseElement).toMatchSnapshot();
    });
    it("renders a guest menu", async () => {
        const { baseElement, getByRole } = render(<Guest />);
        await userEvent.click(getByRole("button"));
        expect(baseElement).toMatchSnapshot();
    });
    it("renders an open menu", async () => {
        const { baseElement } = render(<Open />);
        expect(baseElement).toMatchSnapshot();
    });
    it("renders a menu without an avatar", async () => {
        const { baseElement } = render(<NoAvatar />);
        expect(baseElement).toMatchSnapshot();
    });
    it("renders an open menu with user status", async () => {
        const { container } = render(<WithStatusOpen />);
        expect(container).toMatchSnapshot();
    });
});

describe("UserMenu presence controls", () => {
    const presenceModel = (overrides: Partial<PresenceSnapshot> = {}) =>
        Object.assign(
            new MockViewModel<PresenceSnapshot>({ enabled: true, preference: "online", busy: false, ...overrides }),
            { setPreference: vi.fn().mockResolvedValue(undefined), retry: vi.fn().mockResolvedValue(undefined) },
        );

    it("should expose real presence choices from the profile menu", async () => {
        const presence = presenceModel();
        const { getByRole, getByText, queryByText } = render(<Open presence={presence} />);
        await userEvent.click(getByRole("menuitem", { name: "Requested: Online (automatic)" }));
        expect(getByText("Status unknown")).toBeVisible();
        expect(getByRole("menuitemradio", { name: "Online (automatic)" })).toHaveAttribute("aria-checked", "true");
        expect(queryByText("Do not disturb")).toBeNull();
        await userEvent.click(getByRole("menuitemradio", { name: "Appear offline" }));
        expect(presence.setPreference).toHaveBeenCalledWith("offline");
    });

    it("should explain explicitly disabled presence without offering changes", async () => {
        const presence = presenceModel({ enabled: false });
        const { getByRole, getByText, queryByRole } = render(<Open presence={presence} />);
        await userEvent.click(getByRole("menuitem", { name: "Presence disabled" }));
        expect(getByText("Presence is disabled in this client’s configuration.")).toBeVisible();
        expect(queryByRole("menuitemradio")).toBeNull();
        expect(presence.setPreference).not.toHaveBeenCalled();
    });

    it("should retain requested intent, expose errors and allow retry", async () => {
        const presence = presenceModel({ preference: "offline", error: "Could not update presence" });
        const { getByRole } = render(<Open presence={presence} />);
        await userEvent.click(getByRole("menuitem", { name: "Requested: Appear offline" }));
        expect(getByRole("alert")).toHaveTextContent("Could not update presence");
        await userEvent.click(getByRole("menuitem", { name: "Retry presence update" }));
        expect(presence.retry).toHaveBeenCalledOnce();
    });
});
