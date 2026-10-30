/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useState } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopProfileEditorView,
    type DesktopProfileEditorDraft,
    type DesktopProfileEditorViewActions,
    type DesktopProfileEditorViewSnapshot,
} from "./DesktopProfileEditorView";
import { useMockedViewModel } from "../../core/viewmodel";

const DRAFT: DesktopProfileEditorDraft = {
    displayName: "chopin",
    pronouns: "he/him",
    bio: "Building Aether.",
    statusEmoji: "🎹",
    statusText: "Nocturne in E-flat",
    theme: { primary: "#14163a", accent: "#7b2fd0" },
    decoration: "neon-ring",
    effect: "stars",
    nameplate: "moonlit",
    hasNameplateImage: false,
    nameStyle: { font: "pixel", effect: "neon", colour: "#ff7ab6", colourEnd: "#7b2fd0" },
    links: [{ id: "1", label: "Site", url: "https://example.org", invalid: false }],
    boardTitle: "Games I like",
    board: [{ id: "1", title: "Squad", caption: "brrr" }],
};

function EditorStory(snapshot: DesktopProfileEditorViewSnapshot): JSX.Element {
    // Applied locally so the story behaves like the real editor: pick something and watch the preview follow.
    const [draft, setDraft] = useState(snapshot.draft);
    const vm = useMockedViewModel<DesktopProfileEditorViewSnapshot, DesktopProfileEditorViewActions>(
        {
            ...snapshot,
            draft,
            preview: {
                ...snapshot.preview,
                displayName: draft.displayName,
                bio: draft.bio,
                pronouns: draft.pronouns,
                status: draft.statusText ? { emoji: draft.statusEmoji, text: draft.statusText } : undefined,
                appearance: {
                    theme: draft.theme,
                    decoration: draft.decoration,
                    effect: draft.effect,
                    nameplate: draft.nameplate ? { preset: draft.nameplate } : undefined,
                    nameStyle: draft.nameStyle,
                },
            },
        },
        {
            update: (patch) => setDraft((current) => ({ ...current, ...patch })),
            chooseAvatar: fn(),
            removeAvatar: fn(),
            chooseBanner: fn(),
            removeBanner: fn(),
            chooseNameplateImage: fn(),
            surpriseName: fn(),
            addLink: fn(),
            updateLink: fn(),
            removeLink: fn(),
            addBoardItem: fn(),
            updateBoardItem: fn(),
            removeBoardItem: fn(),
            save: fn(),
            reset: fn(),
        },
    );
    return <DesktopProfileEditorView vm={vm} />;
}

const meta = {
    title: "Desktop/Profile/Editor",
    component: EditorStory,
    args: {
        state: "ready",
        draft: DRAFT,
        preview: { userId: "@chopin:matrix.org", displayName: "chopin", presence: "online", roles: [] },
        hasBanner: false,
        hasAvatar: false,
        canSetDisplayName: true,
        canSetAvatar: true,
        tagOptions: [
            { spaceId: "!s:example.org", label: "ENG", emoji: "💗", colour: "#ff7ab6", spaceName: "English Server" },
        ],
        dirty: true,
        saving: false,
        saved: false,
        tooLarge: false,
        maxLinks: 6,
        maxBoardItems: 8,
    },
} satisfies Meta<typeof EditorStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Unsupported: Story = { args: { state: "unsupported" } };
export const ReadOnly: Story = { args: { state: "read_only" } };
export const SaveFailed: Story = { args: { error: "Your homeserver asked to slow down. Try again in a moment." } };
