/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { composeStories } from "@storybook/react-vite";
import { describe, expect, it, type Mock } from "vitest";

import * as stories from "./CategoryDialogView.stories";

const { Create, Named, Rename, Busy, Failed } = composeStories(stories);

describe("<CategoryDialogView />", () => {
    it("asks for the new category's name and can't create it empty", async () => {
        const user = userEvent.setup();
        render(<Create />);
        expect(screen.getByRole("heading", { name: "Create category" })).toBeInTheDocument();
        const input = screen.getByRole("textbox", { name: "Category name" });
        expect(input).toHaveFocus();
        expect(input).toHaveAttribute("maxlength", "100");
        expect(screen.getByRole("button", { name: "Create category" })).toBeDisabled();
        await user.type(input, "G");
        expect(Create.args.setName).toHaveBeenCalledWith("G");
    });

    it("creates the category on submit, including with Enter", async () => {
        const user = userEvent.setup();
        (Named.args.submit as Mock).mockClear();
        render(<Named />);
        await user.type(screen.getByRole("textbox", { name: "Category name" }), "{Enter}");
        expect(Named.args.submit).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Create category" }));
        expect(Named.args.submit).toHaveBeenCalledTimes(2);
    });

    it("renames an existing category", () => {
        render(<Rename />);
        expect(screen.getByRole("heading", { name: "Edit category" })).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Category name" })).toHaveValue("Variedades");
        expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("locks the form while saving", async () => {
        const user = userEvent.setup();
        (Busy.args.submit as Mock).mockClear();
        render(<Busy />);
        expect(screen.getByRole("textbox", { name: "Category name" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: /Create category/ }));
        expect(Busy.args.submit).not.toHaveBeenCalled();
    });

    it("says why saving failed and can be cancelled", async () => {
        const user = userEvent.setup();
        render(<Failed />);
        expect(screen.getByRole("alert").textContent).toContain("save the category");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(Failed.args.cancel).toHaveBeenCalled();
    });
});
