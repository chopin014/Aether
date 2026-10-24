/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { TopicDialogView, type TopicDialogViewSnapshot } from "./TopicDialogView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<TopicDialogViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<TopicDialogViewSnapshot>({
            name: "general",
            kind: "text",
            topic: "Release planning https://example.org",
            canEdit: true,
            ...snapshot,
        }),
        { onEdit: vi.fn(), onClose: vi.fn() },
    );
}

describe("TopicDialogView", () => {
    it("shows the channel name and the whole topic, with links", () => {
        render(<TopicDialogView vm={makeVm()} />);
        expect(screen.getByRole("heading", { name: "general" })).toBeVisible();
        expect(screen.getByRole("link", { name: "https://example.org" })).toBeVisible();
    });

    it("edits and closes through the view model", async () => {
        const vm = makeVm();
        render(<TopicDialogView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Edit topic" }));
        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(vm.onEdit).toHaveBeenCalled();
        expect(vm.onClose).toHaveBeenCalled();
    });

    it("hides Edit from those who may not change the topic", () => {
        render(<TopicDialogView vm={makeVm({ canEdit: false })} />);
        expect(screen.queryByRole("button", { name: "Edit topic" })).not.toBeInTheDocument();
    });
});
