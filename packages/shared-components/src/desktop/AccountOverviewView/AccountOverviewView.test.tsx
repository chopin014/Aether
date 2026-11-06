/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { MockViewModel } from "../../core/viewmodel";
import {
    AccountOverviewView,
    type AccountOverviewViewActions,
    type AccountOverviewViewSnapshot,
} from "./AccountOverviewView";

const SNAPSHOT: AccountOverviewViewSnapshot = {
    identity: { userId: "@chopin:matrix.org", displayName: "chopin", roles: [] },
    emails: [],
    canChangeEmails: true,
    password: "managed",
    accountManagementHost: "matrix.org",
    sessionCount: 3,
    canDeactivate: true,
    copied: false,
};

function makeViewModel(
    snapshot: Partial<AccountOverviewViewSnapshot> = {},
): MockViewModel<AccountOverviewViewSnapshot> & AccountOverviewViewActions {
    return Object.assign(new MockViewModel<AccountOverviewViewSnapshot>({ ...SNAPSHOT, ...snapshot }), {
        editProfile: vi.fn(),
        copyUserId: vi.fn(),
        toggleEmailEditor: vi.fn(),
        togglePasswordEditor: vi.fn(),
        manageAccount: vi.fn(),
        openSessions: vi.fn(),
        deactivate: vi.fn(),
    });
}

describe("AccountOverviewView", () => {
    it("shows the profile card with the name, ID and email", () => {
        render(<AccountOverviewView vm={makeViewModel()} />);

        const profile = screen.getByRole("region", { name: "Your profile" });
        expect(within(profile).getAllByText("chopin")).toHaveLength(2);
        expect(within(profile).getAllByText("@chopin:matrix.org")).toHaveLength(2);
        expect(within(profile).getByText("No email added")).toBeInTheDocument();
    });

    it("opens the profile editor from the card and the display name row", async () => {
        const vm = makeViewModel();
        render(<AccountOverviewView vm={vm} />);

        await userEvent.click(screen.getByRole("button", { name: "Edit profile" }));
        await userEvent.click(screen.getByRole("button", { name: "Edit" }));
        expect(vm.editProfile).toHaveBeenCalledTimes(2);
    });

    it("copies the user ID and says so", async () => {
        const vm = makeViewModel();
        const { rerender } = render(<AccountOverviewView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Copy" }));
        expect(vm.copyUserId).toHaveBeenCalled();

        rerender(<AccountOverviewView vm={makeViewModel({ copied: true })} />);
        expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("sends people to their account provider when it manages the password", async () => {
        const vm = makeViewModel();
        render(<AccountOverviewView vm={vm} />);

        expect(screen.getByText("Managed by your account provider (matrix.org)")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Manage account" }));
        expect(vm.manageAccount).toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
    });

    it("shows the password form under its row while it is open", () => {
        render(
            <AccountOverviewView
                vm={makeViewModel({ password: "change", editing: "password" })}
                passwordEditor={<form aria-label="Password form" />}
            />,
        );

        expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("form", { name: "Password form" })).toBeInTheDocument();
    });

    it("keeps editors hidden until their row is opened", () => {
        render(
            <AccountOverviewView
                vm={makeViewModel({ password: "change" })}
                emailEditor={<form aria-label="Email form" />}
                passwordEditor={<form aria-label="Password form" />}
            />,
        );

        expect(screen.queryByRole("form")).not.toBeInTheDocument();
    });

    it("opens the email editor", async () => {
        const vm = makeViewModel();
        render(<AccountOverviewView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Add" }));
        expect(vm.toggleEmailEditor).toHaveBeenCalled();
    });

    it("hides the email action when the server does not allow changes", () => {
        render(<AccountOverviewView vm={makeViewModel({ canChangeEmails: false })} />);
        expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    });

    it("counts the sessions and opens them", async () => {
        const vm = makeViewModel();
        render(<AccountOverviewView vm={vm} />);

        await userEvent.click(screen.getByRole("button", { name: /Signed-in devices/ }));
        expect(screen.getByText("3 active sessions · review any you don't recognise")).toBeInTheDocument();
        expect(vm.openSessions).toHaveBeenCalled();
    });

    it("keeps deactivation in a separate danger zone", async () => {
        const vm = makeViewModel({ password: "change", accountManagementHost: undefined });
        render(<AccountOverviewView vm={vm} />);

        const danger = screen.getByRole("region", { name: "Danger zone" });
        expect(
            within(danger).getByText("Permanent. You lose access to this account and its messages."),
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Deactivate…" }));
        expect(vm.deactivate).toHaveBeenCalled();
    });

    it("says deactivation happens at the account provider when it manages the account", () => {
        render(<AccountOverviewView vm={makeViewModel()} />);
        const danger = screen.getByRole("region", { name: "Danger zone" });
        expect(
            within(danger).getByText("Permanent. Done on your account provider's site (matrix.org)."),
        ).toBeInTheDocument();
    });

    it("leaves out the danger zone when the account cannot be deactivated here", () => {
        render(<AccountOverviewView vm={makeViewModel({ canDeactivate: false })} />);
        expect(screen.queryByRole("region", { name: "Danger zone" })).not.toBeInTheDocument();
    });
});
