/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    CategoryDialogView,
    type CategoryDialogViewActions,
    type CategoryDialogViewSnapshot,
} from "./CategoryDialogView";
import { useMockedViewModel } from "../../core/viewmodel";

type CategoryStoryProps = CategoryDialogViewSnapshot & CategoryDialogViewActions;

function CategoryStory({ setName, submit, cancel, ...snapshot }: CategoryStoryProps): JSX.Element {
    const vm = useMockedViewModel<CategoryDialogViewSnapshot, CategoryDialogViewActions>(snapshot, {
        setName,
        submit,
        cancel,
    });
    return <CategoryDialogView vm={vm} />;
}

const meta = {
    title: "Desktop/CategoryDialog",
    component: CategoryStory,
    args: {
        mode: "create",
        name: "",
        canSubmit: false,
        busy: false,
        setName: fn(),
        submit: fn(),
        cancel: fn(),
    },
} satisfies Meta<typeof CategoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Naming a new category. */
export const Create: Story = {};
/** A name typed, ready to create. */
export const Named: Story = { args: { name: "Governo", canSubmit: true } };
/** Renaming a category. */
export const Rename: Story = { args: { mode: "rename", name: "Variedades", canSubmit: true } };
/** Sending the change. */
export const Busy: Story = { args: { name: "Governo", canSubmit: true, busy: true } };
/** The server refused the change. */
export const Failed: Story = {
    args: { name: "Governo", canSubmit: true, error: "Couldn't save the category. Try again." },
};
