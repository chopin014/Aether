/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    ServerNicknameDialogView,
    type ServerNicknameDialogViewActions,
    type ServerNicknameDialogViewSnapshot,
} from "./ServerNicknameDialogView";
import { useMockedViewModel } from "../../core/viewmodel";

const actions: ServerNicknameDialogViewActions = {
    setNickname: fn(),
    save: fn(),
    reset: fn(),
    cancel: fn(),
};

function DialogStory(snapshot: ServerNicknameDialogViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<ServerNicknameDialogViewSnapshot, ServerNicknameDialogViewActions>(snapshot, actions);
    return <ServerNicknameDialogView vm={vm} />;
}

const meta = {
    title: "Desktop/ServerNicknameDialog",
    component: DialogStory,
    args: {
        forSelf: false,
        personName: "hLiTz",
        nickname: "sdds do litz",
        canReset: true,
        setByModerator: false,
        busy: false,
    },
} satisfies Meta<typeof DialogStory>;
// Storybook indexes the metadata through its required default export.
export default meta;
type Story = StoryObj<typeof meta>;

/** A moderator changing someone else's nickname, with Discord's warning. */
export const Moderator: Story = {};
/** The user's own nickname, with nothing set yet. */
export const OwnNickname: Story = { args: { forSelf: true, nickname: "", canReset: false } };
/** The user's own nickname while a moderator's applies. */
export const SetByModerator: Story = { args: { forSelf: true, setByModerator: true } };
export const Failed: Story = { args: { error: "You don't have permission to do that." } };
