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

import * as Stories from "./DmOngoingCallTileView.stories";
import { EventPresentationProvider } from "../../../../EventPresentation";

const {
    IncomingVideoCall,
    IncomingVoiceCall,
    OutgoingVideoCall,
    OutgoingVoiceCall,
    VideoCallInProgress,
    VoiceCallInProgress,
} = composeStories(Stories);

describe("DmOngoingCallTileView", () => {
    describe("renders the tile", () => {
        it("IncomingVideoCall", () => {
            const { container } = render(<IncomingVideoCall />);
            expect(container).toMatchSnapshot();
        });

        it("IncomingVoiceCall", () => {
            const { container } = render(<IncomingVoiceCall />);
            expect(container).toMatchSnapshot();
        });

        it("OutgoingVideoCall", () => {
            const { container } = render(<OutgoingVideoCall />);
            expect(container).toMatchSnapshot();
        });

        it("OutgoingVoiceCall", () => {
            const { container } = render(<OutgoingVoiceCall />);
            expect(container).toMatchSnapshot();
        });

        it("VoiceCallInProgress", () => {
            const { container } = render(<VoiceCallInProgress />);
            expect(container).toMatchSnapshot();
        });

        it("VideoCallInProgress", () => {
            const { container } = render(<VideoCallInProgress />);
            expect(container).toMatchSnapshot();
        });
    });

    describe("in the desktop message style", () => {
        const renderDesktop = (story: React.ReactElement): ReturnType<typeof render> =>
            render(
                <EventPresentationProvider value={{ layout: "group", density: "default", messageStyle: "desktop" }}>
                    {story}
                </EventPresentationProvider>,
            );

        it("renders a call history row with a live marker instead of a boxed tile", () => {
            const { container } = renderDesktop(<IncomingVoiceCall />);
            expect(container.querySelector("[data-call-history]")).not.toBeNull();
            expect(screen.getByText("Ongoing")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
        });

        it("hides the join button once we are in the call", () => {
            renderDesktop(<VoiceCallInProgress isJoined={true} />);
            expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
        });
    });
});
