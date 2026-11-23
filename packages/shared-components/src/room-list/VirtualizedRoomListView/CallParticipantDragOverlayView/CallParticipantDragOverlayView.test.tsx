/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen, within } from "@test-utils";
import { composeStories } from "@storybook/react-vite";
import { describe, it, expect } from "vitest";

import * as stories from "./CallParticipantDragOverlayView.stories";

const { Default } = composeStories(stories);

describe("<CallParticipantDragOverlayView />", () => {
    it("shows the person being dragged, hidden from assistive technology", () => {
        render(<Default />);
        const overlay = screen.getByTestId("call-participant-drag-overlay");
        expect(within(overlay).getByText("chopin")).toBeVisible();
        expect(overlay).toHaveAttribute("aria-hidden", "true");
    });
});
