/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { SoundboardClipView } from "./SoundboardClipView";

function show(disabled = false) {
    const props = {
        clip: {
            name: "long.wav",
            duration: 20,
            peaks: [0.2, 0.8, 1, 0.4],
            start: 5,
            end: 15,
            playing: false,
            volume: 100,
            position: 5,
        },
        disabled,
        onRange: vi.fn(),
        onPreview: vi.fn(),
        onVolume: vi.fn(),
        onCancel: vi.fn(),
        onSave: vi.fn(),
    };
    const { rerender } = render(<SoundboardClipView {...props} />);
    return {
        ...props,
        setDisabled: (disabled: boolean) => rerender(<SoundboardClipView {...props} disabled={disabled} />),
    };
}

describe("SoundboardClipView", () => {
    it("supports precise keyboard trimming, local preview, cancel and upload", async () => {
        const props = show();
        expect(screen.getByText("long.wav")).toBeVisible();
        expect(screen.getByText("0:10.0 / 0:10.0")).toBeVisible();
        const position = screen.getByRole("slider", { name: "Selection position" });
        await userEvent.click(position);
        await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
        expect(props.onRange).toHaveBeenCalledWith(6, 16);
        const start = screen.getByRole("slider", { name: "Selection start" });
        await userEvent.click(start);
        await userEvent.keyboard("{ArrowRight}");
        expect(props.onRange).toHaveBeenCalledWith(5.1, 15);
        const end = screen.getByRole("slider", { name: "Selection end" });
        await userEvent.click(end);
        await userEvent.keyboard("{ArrowLeft}");
        expect(props.onRange).toHaveBeenCalledWith(5, 14.9);
        await userEvent.click(screen.getByRole("button", { name: "Play selected audio" }));
        expect(props.onPreview).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Upload sound" }));
        expect(props.onSave).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(props.onCancel).toHaveBeenCalledOnce();
    });
    it("disables editing and duplicate uploads while saving", () => {
        show(true);
        expect(screen.getByRole("button", { name: "Upload sound" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Play selected audio" })).toBeDisabled();
        expect(screen.getByRole("slider", { name: "Selection start" })).toBeDisabled();
    });
    it("focuses the preview after decoding finishes and the upload form becomes enabled", () => {
        const props = show(true);
        const preview = screen.getByRole("button", { name: "Play selected audio" });
        expect(preview).not.toHaveFocus();
        props.setDisabled(false);
        expect(preview).toHaveFocus();
    });
});
