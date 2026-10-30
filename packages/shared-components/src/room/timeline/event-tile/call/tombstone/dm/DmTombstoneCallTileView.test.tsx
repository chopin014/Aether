/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { composeStories } from "@storybook/react-vite";
import { describe, expect, it } from "vitest";
import React from "react";
import { fireEvent, render, screen } from "@test-utils";

import * as Stories from "./DmTombstoneCallTileView.stories";

const { IncomingVideoDeclined, OutgoingVideoDeclined, VideoEnded, VoiceEnded, InTimeline } = composeStories(Stories);

describe("DmTombstoneCallTileView", () => {
    it("should reveal message actions when the call history row is hovered", () => {
        render(<InTimeline />);
        const row = screen.getByText(/started a voice call/).closest('[data-testid="event-tile"]')!;
        expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
        fireEvent.mouseEnter(row);
        expect(screen.getByRole("toolbar")).toBeVisible();
        fireEvent.mouseLeave(row);
        expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    });

    it("should show the caller, call type and timestamp inline", () => {
        render(<VoiceEnded startedByDisplayName="Alice" timestamp="16:50" />);
        expect(screen.getByText("Alice", { selector: "strong" })).toBeVisible();
        expect(screen.getByText(/started a voice call/)).toBeVisible();
        expect(screen.getByText("16:50")).toBeVisible();
    });

    it("should distinguish video history from voice history", () => {
        render(<VideoEnded startedByDisplayName="Alice" />);
        expect(screen.getByText(/started a video call/)).toBeVisible();
    });

    describe("renders the tile", () => {
        it("IncomingVideoDeclined", () => {
            const { container } = render(<IncomingVideoDeclined />);
            expect(container).toMatchSnapshot();
        });

        it("OutgoingVideoDeclined", () => {
            const { container } = render(<OutgoingVideoDeclined />);
            expect(container).toMatchSnapshot();
        });

        it("VideoEnded", () => {
            const { container } = render(<VideoEnded />);
            expect(container).toMatchSnapshot();
        });

        it("VoiceEnded", () => {
            const { container } = render(<VoiceEnded />);
            expect(container).toMatchSnapshot();
        });
    });
});
