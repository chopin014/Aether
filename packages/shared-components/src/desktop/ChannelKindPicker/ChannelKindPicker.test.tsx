/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChannelKindPicker } from "./ChannelKindPicker";

describe("ChannelKindPicker", () => {
    it("offers both kinds as a labelled radio group with the value checked", () => {
        render(<ChannelKindPicker value="voice" onChange={vi.fn()} />);
        expect(screen.getByRole("radiogroup", { name: "Channel type" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "Text" })).not.toBeChecked();
        expect(screen.getByRole("radio", { name: "Voice" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Voice" })).toHaveAccessibleDescription(
            "Talk together with voice, video and screen sharing",
        );
    });

    it("reports the kind picked by clicking anywhere on its card", async () => {
        const onChange = vi.fn();
        render(<ChannelKindPicker value="text" onChange={onChange} />);
        await userEvent.click(screen.getByText("Talk together with voice, video and screen sharing"));
        expect(onChange).toHaveBeenCalledWith("voice");
    });

    it("moves between kinds with the arrow keys", async () => {
        const onChange = vi.fn();
        render(<ChannelKindPicker value="text" onChange={onChange} />);
        await userEvent.tab();
        expect(screen.getByRole("radio", { name: "Text" })).toHaveFocus();
        await userEvent.keyboard("{ArrowDown}");
        expect(onChange).toHaveBeenCalledWith("voice");
    });
});
