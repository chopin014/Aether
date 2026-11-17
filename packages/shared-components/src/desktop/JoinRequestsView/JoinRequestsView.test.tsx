/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { JoinRequestsView, type JoinRequestsViewSnapshot } from "./JoinRequestsView";
import { MockViewModel } from "../../core/viewmodel";

function renderRequests(snapshot: Partial<JoinRequestsViewSnapshot> = {}) {
    const vm = Object.assign(
        new MockViewModel<JoinRequestsViewSnapshot>({
            requests: [
                { userId: "@carol:matrix.org", name: "Carol", reason: "Bob sent me the link" },
                { userId: "@dave:example.org", name: "Dave" },
            ],
            expanded: true,
            canDecline: true,
            busyIds: [],
            ...snapshot,
        }),
        { toggle: vi.fn(), approve: vi.fn(), decline: vi.fn() },
    );
    const { container } = render(<JoinRequestsView vm={vm} />);
    return { vm, container };
}

describe("JoinRequestsView", () => {
    it("shows nothing when nobody is asking to join", () => {
        const { container } = renderRequests({ requests: [] });
        expect(container).toBeEmptyDOMElement();
    });

    it("lists who is asking, with their username and message", () => {
        renderRequests();
        expect(screen.getByRole("button", { name: "2 2 people want to join" })).toHaveAttribute(
            "aria-expanded",
            "true",
        );
        expect(screen.getByText("Carol")).toBeVisible();
        expect(screen.getByText("@carol:matrix.org")).toBeVisible();
        expect(screen.getByText("“Bob sent me the link”")).toBeVisible();
        expect(screen.getByText("@dave:example.org")).toBeVisible();
    });

    it("counts one person in the singular", () => {
        renderRequests({ requests: [{ userId: "@carol:matrix.org", name: "Carol" }] });
        expect(screen.getByText("1 person wants to join")).toBeVisible();
    });

    it("lets someone in or turns them down", async () => {
        const { vm } = renderRequests();
        await userEvent.click(screen.getByRole("button", { name: "Let Carol in" }));
        expect(vm.approve).toHaveBeenCalledWith("@carol:matrix.org");
        await userEvent.click(screen.getByRole("button", { name: "Decline Dave" }));
        expect(vm.decline).toHaveBeenCalledWith("@dave:example.org");
    });

    it("hides declining from people who cannot remove members", () => {
        renderRequests({ canDecline: false });
        expect(screen.getByRole("button", { name: "Let Carol in" })).toBeVisible();
        expect(screen.queryByRole("button", { name: "Decline Carol" })).not.toBeInTheDocument();
    });

    it("disables the buttons of a request being answered", () => {
        renderRequests({ busyIds: ["@carol:matrix.org"] });
        expect(screen.getByRole("button", { name: "Let Carol in" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Let Dave in" })).toBeEnabled();
    });

    it("closes to just the count and reports errors", async () => {
        const { vm } = renderRequests({ expanded: false, error: "That didn't work. Try again." });
        expect(screen.queryByText("Carol")).not.toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("That didn't work. Try again.");
        await userEvent.click(screen.getByRole("button", { name: /want to join/ }));
        expect(vm.toggle).toHaveBeenCalled();
    });
});
