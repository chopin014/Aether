/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen } from "@test-utils";
import { composeStories } from "@storybook/react-vite";
import { describe, expect, it } from "vitest";

import "@vector-im/compound-design-tokens/assets/web/css/compound-design-tokens.css";
import "@vector-im/compound-web/dist/style.css";
import * as stories from "./RoomListItemView.stories";

const { DesktopVoiceChannelOccupied, DesktopVoiceChannelWithIconAndParticipants } = composeStories(stories);

describe("Voice channel grid", () => {
    const left = (element: Element | null): number => element!.getBoundingClientRect().left;
    const avatar = (): Element | null =>
        screen.getByRole("button", { name: "Alice" }).querySelector("[class*=participantAvatar]");
    const participantName = (): Element | null =>
        screen.getByRole("button", { name: "Alice" }).querySelector("[class*=participantName]");

    it("should line up a channel's image with the avatars, and its name with their names", () => {
        const { container } = render(<DesktopVoiceChannelWithIconAndParticipants />);
        const image = container.querySelector("img");
        expect(left(image)).toBe(left(avatar()));
        expect(image!.getBoundingClientRect().width).toBe(avatar()!.getBoundingClientRect().width);
        expect(left(screen.getByTestId("room-name"))).toBe(left(participantName()));
        expect(left(avatar())).toBeGreaterThan(left(screen.getByTestId("channel-kind-voice")));
    });

    it("should line up the avatars with the channel's name when it has no image", () => {
        render(<DesktopVoiceChannelOccupied />);
        expect(left(screen.getByTestId("room-name"))).toBe(left(avatar()));
        expect(left(participantName())).toBeGreaterThan(left(avatar()));
    });
});
