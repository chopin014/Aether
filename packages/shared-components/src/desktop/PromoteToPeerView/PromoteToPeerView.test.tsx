/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { PromoteToPeerView, type PromoteToPeerViewSnapshot } from "./PromoteToPeerView";
import { MockViewModel } from "../../core/viewmodel";

function renderConfirmation(snapshot: Partial<PromoteToPeerViewSnapshot> = {}) {
    const vm = Object.assign(
        new MockViewModel<PromoteToPeerViewSnapshot>({
            target: { name: "Bob" },
            roomName: "Gamers",
            isServer: true,
            phrase: "I want to make Bob as powerful as me",
            typed: "",
            matches: false,
            ...snapshot,
        }),
        { setTyped: vi.fn(), confirm: vi.fn(), cancel: vi.fn() },
    );
    render(<PromoteToPeerView vm={vm} />);
    return vm;
}

describe("PromoteToPeerView", () => {
    it("explains what the promotion allows and shows the sentence to type", () => {
        renderConfirmation();
        expect(screen.getByText(/Bob will get the same power as you in Gamers/)).toBeVisible();
        expect(screen.getByText(/delete channels/)).toBeVisible();
        expect(screen.getByText(/cannot take this back/)).toBeVisible();
        expect(screen.getByTestId("promote-peer-phrase")).toHaveTextContent("I want to make Bob as powerful as me");
    });

    it("names a channel and counts several people", () => {
        renderConfirmation({ target: { count: 3 }, isServer: false, roomName: "general" });
        expect(screen.getByText(/3 people will get the same power as you in the channel general/)).toBeVisible();
    });

    it("sends typing to the model and keeps confirm disabled until the sentence matches", async () => {
        const vm = renderConfirmation();
        expect(screen.getByRole("button", { name: "Give the same power" })).toBeDisabled();
        await userEvent.type(screen.getByRole("textbox"), "I");
        expect(vm.setTyped).toHaveBeenCalledWith("I");
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(vm.cancel).toHaveBeenCalledOnce();
    });

    it("confirms with the button or Enter once the sentence matches", async () => {
        const vm = renderConfirmation({ typed: "I want to make Bob as powerful as me", matches: true });
        await userEvent.click(screen.getByRole("button", { name: "Give the same power" }));
        expect(vm.confirm).toHaveBeenCalledOnce();
        await userEvent.type(screen.getByRole("textbox"), "{Enter}");
        expect(vm.confirm).toHaveBeenCalledTimes(2);
    });

    it("refuses pasted text", () => {
        renderConfirmation();
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        screen.getByRole("textbox").dispatchEvent(paste);
        expect(paste.defaultPrevented).toBe(true);
    });
});
