/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";

import { MockViewModel } from "../../core/viewmodel";
import {
    MessageDisplayView,
    type MessageDisplayViewActions,
    type MessageDisplayViewSnapshot,
} from "./MessageDisplayView";

class TestMessageDisplayViewModel extends MockViewModel<MessageDisplayViewSnapshot> {
    public setDisplay = vi.fn<MessageDisplayViewActions["setDisplay"]>();
    public setGroupSpacing = vi.fn<MessageDisplayViewActions["setGroupSpacing"]>();
}

function renderView(snapshot: Partial<MessageDisplayViewSnapshot> = {}): TestMessageDisplayViewModel {
    const vm = new TestMessageDisplayViewModel({
        display: "cozy",
        groupSpacing: 16,
        groupSpacingOptions: [0, 4, 8, 16, 24],
        ...snapshot,
    });
    render(<MessageDisplayView vm={vm} />);
    return vm;
}

describe("MessageDisplayView", () => {
    it("shows the layout and spacing in use", () => {
        renderView({ display: "compact", groupSpacing: 8 });

        expect(screen.getByRole("radio", { name: /Compact/ })).toBeChecked();
        expect(screen.getByRole("radio", { name: /Cozy/ })).not.toBeChecked();
        expect(screen.getByRole("radio", { name: "8px" })).toBeChecked();
    });

    it("switches layout", () => {
        const vm = renderView();

        fireEvent.click(screen.getByRole("radio", { name: /Compact/ }));

        expect(vm.setDisplay).toHaveBeenCalledWith("compact");
    });

    it("changes the space between message groups", () => {
        const vm = renderView();

        fireEvent.click(screen.getByRole("radio", { name: "24px" }));

        expect(vm.setGroupSpacing).toHaveBeenCalledWith(24);
    });
});
