/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopFullProfileView,
    type DesktopFullProfileViewActions,
    type DesktopFullProfileViewSnapshot,
} from "./DesktopFullProfileView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DesktopFullProfileViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopFullProfileViewSnapshot>({
            userId: "@robin:example.org",
            displayName: "Robin",
            presence: "unavailable",
            roles: [{ key: "admin", label: "Admin" }],
            isMe: false,
            canMessage: true,
            canVerify: true,
            isVerified: false,
            canMention: false,
            isIgnored: false,
            canModerate: false,
            memberSince: { text: "May 3, 2026", datetime: "2026-05-03T10:00:00.000Z" },
            verification: { verified: false, deviceCount: 2 },
            mutualRooms: { state: "ready", items: [{ id: "!a:example.org", name: "general" }] },
            mutualSpaces: [{ id: "!s:example.org", name: "Aether HQ" }],
            ...snapshot,
        }),
        {
            message: vi.fn(),
            verify: vi.fn(),
            mention: vi.fn(),
            copyLink: vi.fn(),
            toggleIgnore: vi.fn(),
            moderate: vi.fn(),
            openRoom: vi.fn(),
            retryMutualRooms: vi.fn(),
            close: vi.fn(),
        } satisfies DesktopFullProfileViewActions,
    );
}

describe("DesktopFullProfileView", () => {
    it("shows identity, membership date and verification state", () => {
        render(<DesktopFullProfileView vm={makeVm()} />);
        expect(screen.getByRole("heading", { name: "Robin" })).toBeVisible();
        expect(screen.getByText("May 3, 2026")).toHaveAttribute("datetime", "2026-05-03T10:00:00.000Z");
        expect(screen.getByText("Not verified · 2 sessions")).toBeVisible();
        expect(screen.getByRole("img", { name: "Away" })).toBeInTheDocument();
    });

    it("omits sections that have no real data", () => {
        render(<DesktopFullProfileView vm={makeVm({ memberSince: undefined, verification: undefined })} />);
        expect(screen.queryByText("Member since")).toBeNull();
        expect(screen.queryByText("Verification")).toBeNull();
    });

    it("opens a mutual room and switches to the spaces tab with the keyboard", async () => {
        const vm = makeVm();
        render(<DesktopFullProfileView vm={vm} />);
        expect(screen.getByRole("tab", { name: "1 mutual room", selected: true })).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: /general/ }));
        expect(vm.openRoom).toHaveBeenCalledWith("!a:example.org");
        screen.getByRole("tab", { name: "1 mutual room" }).focus();
        await userEvent.keyboard("{ArrowRight}");
        expect(screen.getByRole("tab", { name: "1 mutual server", selected: true })).toHaveFocus();
        expect(screen.getByRole("button", { name: /Aether HQ/ })).toBeVisible();
        expect(screen.getByText("Based on the server members this client has loaded.")).toBeVisible();
    });

    it("hides the mutual rooms tab when the server cannot provide them", () => {
        render(<DesktopFullProfileView vm={makeVm({ mutualRooms: { state: "unsupported", items: [] } })} />);
        expect(screen.queryByRole("tab", { name: /mutual room/ })).toBeNull();
        expect(screen.getByRole("tab", { name: "1 mutual server", selected: true })).toBeVisible();
    });

    it("reports a mutual rooms failure with a retry", async () => {
        const vm = makeVm({ mutualRooms: { state: "error", items: [] } });
        render(<DesktopFullProfileView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(vm.retryMutualRooms).toHaveBeenCalled();
    });

    it("forwards message and close, and shows no shared tabs for yourself", async () => {
        const vm = makeVm();
        const { rerender } = render(<DesktopFullProfileView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Message" }));
        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(vm.message).toHaveBeenCalledWith("");
        expect(vm.close).toHaveBeenCalled();
        rerender(<DesktopFullProfileView vm={makeVm({ isMe: true, canMessage: false })} />);
        expect(screen.queryByRole("tablist")).toBeNull();
        expect(screen.getByText("This is your own profile.")).toBeVisible();
    });
});
