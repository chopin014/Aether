/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { composeStories } from "@storybook/react-vite";
import { describe, expect, it } from "vitest";
import React from "react";
import { render, screen } from "@test-utils";

import { CallType } from "../../common";

import * as Stories from "./RoomTombstoneCallTileView.stories";

const { Default } = composeStories(Stories);

describe("RoomTombstoneCallTileView", () => {
    it.each([CallType.Voice, CallType.Video])("should show the caller and %s call intent", (type) => {
        render(<Default type={type} startedByDisplayName="Alice" />);
        expect(screen.getByText("Alice", { selector: "strong" })).toBeVisible();
        expect(
            screen.getByText(type === CallType.Voice ? /started a voice call/ : /started a video call/),
        ).toBeVisible();
    });

    it("renders the tile", () => {
        const { container } = render(<Default />);
        expect(container).toMatchSnapshot();
    });
});
