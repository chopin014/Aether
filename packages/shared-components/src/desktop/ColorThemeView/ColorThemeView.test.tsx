/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";

import { ColorThemeView, type ColorThemeColors, type ColorThemeViewSnapshot } from "./ColorThemeView";
import { MockViewModel } from "../../core/viewmodel/MockViewModel";

const colors: ColorThemeColors = {
    rail: "#121214",
    sidebar: "#121214",
    chat: "#1a1a1e",
    raised: "#222327",
    text: "#efeff1",
    mutedText: "#96979e",
    accent: "#5865f2",
};

function renderView(snapshot: Partial<ColorThemeViewSnapshot> = {}): {
    selectTheme: ReturnType<typeof vi.fn>;
    setColor: ReturnType<typeof vi.fn>;
} {
    const selectTheme = vi.fn();
    const setColor = vi.fn();
    const vm = new MockViewModel<ColorThemeViewSnapshot>({
        groups: [
            {
                id: "discord",
                themes: [
                    { id: "discord-dark", colors },
                    { id: "discord-onyx", colors },
                ],
            },
        ],
        selectedId: "discord-dark",
        colors,
        ...snapshot,
    });
    Object.assign(vm, { selectTheme, setColor });
    render(<ColorThemeView vm={vm as never} />);
    return { selectTheme, setColor };
}

describe("ColorThemeView", () => {
    it("should mark the theme in use", () => {
        renderView();
        expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Onyx" })).not.toBeChecked();
    });

    it("should leave every theme unmarked when none applies", () => {
        renderView({ selectedId: undefined });
        expect(screen.getByRole("radio", { name: "Dark" })).not.toBeChecked();
    });

    it("should choose a theme", () => {
        const { selectTheme } = renderView();
        fireEvent.click(screen.getByRole("radio", { name: "Onyx" }));
        expect(selectTheme).toHaveBeenCalledWith("discord-onyx");
    });

    it("should report the edited colour's role", () => {
        const { setColor } = renderView();
        fireEvent.input(screen.getByLabelText(/Accent/), { target: { value: "#ff0000" } });
        expect(setColor).toHaveBeenCalledWith("accent", "#ff0000");
    });
});
