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
    DesktopThreadCreateView,
    type DesktopThreadCreateSnapshot,
    type DesktopThreadCreateActions,
} from "./DesktopThreadCreateView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DesktopThreadCreateSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopThreadCreateSnapshot>({
            starter: "",
            reply: "",
            sending: false,
            locked: false,
            starterSent: false,
            error: false,
            ...snapshot,
        }),
        {
            setStarter: vi.fn(),
            setReply: vi.fn(),
            submit: vi.fn(),
            cancel: vi.fn(),
        } satisfies DesktopThreadCreateActions,
    );
}

describe("DesktopThreadCreateView", () => {
    it("focuses the starter, labels the Matrix mapping, and forwards editing and cancel", async () => {
        const vm = makeVm();
        render(<DesktopThreadCreateView vm={vm} />);
        expect(screen.getByLabelText("Starter message")).toHaveFocus();
        expect(screen.getByText(/Everyone with access to the channel can read it/)).toBeVisible();
        expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
        await userEvent.type(screen.getByLabelText("Starter message"), "a");
        await userEvent.type(screen.getByLabelText("First reply"), "b");
        expect(vm.setStarter).toHaveBeenCalledWith("a");
        expect(vm.setReply).toHaveBeenCalledWith("b");
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(vm.cancel).toHaveBeenCalledOnce();
        expect(vm.submit).not.toHaveBeenCalled();
    });
    it("submits a complete draft", async () => {
        const vm = makeVm({ starter: "Topic", reply: "Message" });
        render(<DesktopThreadCreateView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Create thread" }));
        expect(vm.submit).toHaveBeenCalledOnce();
    });
    it("locks uncertain sends while keeping retry and accurate partial-send status", async () => {
        const vm = makeVm({ starter: "Topic", reply: "Message", starterSent: true, locked: true, error: true });
        render(<DesktopThreadCreateView vm={vm} />);
        expect(screen.getByRole("alert").textContent).toContain("Your draft is saved");
        expect(screen.getByRole("status").textContent).toContain("The starter was sent");
        expect(screen.getByLabelText("Starter message")).toBeDisabled();
        expect(screen.getByLabelText("First reply")).toBeDisabled();
        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(vm.submit).toHaveBeenCalledOnce();
    });
    it("prevents duplicate submits while sending", () => {
        render(
            <DesktopThreadCreateView
                vm={makeVm({ starter: "Topic", reply: "Message", locked: true, sending: true })}
            />,
        );
        expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
});
