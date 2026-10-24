/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { render, screen, waitFor, within } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { composeStories } from "@storybook/react-vite";
import { describe, it, expect, vi } from "vitest";

import * as stories from "./RoomListItemView.stories";

const {
    Default,
    DesktopActiveThread,
    Selected,
    Bold,
    WithNotification,
    WithMention,
    WithVoiceCall,
    WithVideoCall,
    Invitation,
    UnsentMessage,
    NoMessagePreview,
    WithHoverMenu,
    WithoutHoverMenu,
    DesktopVoiceParticipantSpeaking,
    DesktopVoiceChannelOccupied,
    DesktopChannelWithIcon,
    DesktopVoiceParticipantsSilent,
    DesktopVoiceParticipantsMultipleSpeaking,
    DesktopVoiceParticipantsMutedAndDeafened,
} = composeStories(stories);

describe("<RoomListItemView />", () => {
    it("focuses the active thread independently from opening its parent channel", async () => {
        const onOpen = vi.fn();
        const onRoom = vi.fn();
        render(<DesktopActiveThread onOpenActiveThread={onOpen} onOpenRoom={onRoom} />);
        const thread = screen.getByRole("button", { name: "Open thread Release planning" });
        expect(thread).toHaveAttribute("aria-current", "true");
        await userEvent.click(thread);
        expect(onOpen).toHaveBeenCalledOnce();
        expect(onRoom).not.toHaveBeenCalled();
    });
    it("renders actual members beneath a voice channel and opens their profile separately from joining", async () => {
        const user = userEvent.setup();
        const onProfile = vi.fn();
        render(
            <Default
                channelKind="voice"
                callParticipants={[
                    { userId: "@alice:example.org", name: "Alice" },
                    { userId: "@bob:example.org", name: "Bob" },
                ]}
                onViewCallParticipant={onProfile}
            />,
        );
        const group = screen.getByRole("group", { name: "People in General" });
        expect(group).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Bob" }));
        expect(onProfile).toHaveBeenCalledWith("@bob:example.org");
    });

    it("shows how long an occupied voice channel has had people in it", async () => {
        vi.useFakeTimers({ now: new Date("2026-10-23T12:00:00Z"), toFake: ["Date", "setInterval", "clearInterval"] });
        try {
            render(<DesktopVoiceChannelOccupied callStartedAt={Date.now() - 754_000} />);
            expect(screen.getByText("12:34")).toHaveAttribute("title", "People have been here for 12:34");
            // The channel's own icon replaces the call decoration
            expect(screen.queryByTestId("notification-decoration")?.querySelector("svg")).toBeFalsy();

            vi.advanceTimersByTime(3_600_000);
            expect(await screen.findByText("1:12:34")).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it("shows a channel's custom icon instead of its symbol", () => {
        const { container } = render(<DesktopChannelWithIcon />);
        const icon = container.querySelector("img");
        expect(icon).toHaveAttribute("src", DesktopChannelWithIcon.args.channelIconUrl);
        // The image takes the place of the channel symbol, before the name
        expect(icon?.previousElementSibling).toBeNull();
        expect(icon?.nextElementSibling).toHaveTextContent("General");
    });

    it("shows no duration while a voice channel is empty", () => {
        render(<Default channelKind="voice" callStartedAt={Date.now()} />);
        expect(document.querySelector("time")).toBeNull();
    });

    it("marks only the participants who are speaking", () => {
        render(<DesktopVoiceParticipantsMultipleSpeaking />);
        const alice = screen.getByRole("button", { name: "Alice (speaking)" });
        const bob = screen.getByRole("button", { name: "Bob" });
        const charlie = screen.getByRole("button", { name: "Charlie (speaking)" });

        expect(alice).toHaveAttribute("data-speaking", "true");
        expect(charlie).toHaveAttribute("data-speaking", "true");
        expect(bob).not.toHaveAttribute("data-speaking");
        // The visible name stays the plain display name
        expect(screen.queryByText("Alice (speaking)")).toBeNull();
        // Speaking changes must not be announced as they happen
        expect(document.querySelector("[aria-live]")).toBeNull();
    });

    it("names muted and deafened participants without announcing the change", () => {
        render(<DesktopVoiceParticipantsMutedAndDeafened />);
        expect(screen.getByRole("button", { name: "Alice (speaking)" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Bob (muted)" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Charlie (muted and deafened)" })).toBeVisible();
        expect(screen.getByText("Charlie")).toBeVisible();
        expect(document.querySelector("[aria-live]")).toBeNull();
    });

    it.each([
        { isMuted: false, isDeafened: false, label: "Alice" },
        { isMuted: true, isDeafened: false, label: "Alice (muted)" },
        { isMuted: false, isDeafened: true, label: "Alice (deafened)" },
        { isMuted: true, isDeafened: true, label: "Alice (muted and deafened)" },
    ])("shows the active voice icons for $label", ({ isMuted, isDeafened, label }) => {
        render(
            <Default
                channelKind="voice"
                callParticipants={[{ userId: "@alice:example.org", name: "Alice", isMuted, isDeafened }]}
            />,
        );
        const participant = within(screen.getByRole("button", { name: label }));
        expect(!!participant.queryByTestId("participant-muted")).toBe(isMuted);
        expect(!!participant.queryByTestId("participant-deafened")).toBe(isDeafened);
    });

    it("shows no speaking indicator when everyone is silent", () => {
        render(<DesktopVoiceParticipantsSilent />);
        for (const name of ["Alice", "Bob"]) {
            const participant = screen.getByRole("button", { name });
            expect(participant).not.toHaveAttribute("data-speaking");
        }
        expect(document.querySelector("[data-speaking]")).toBeNull();
    });

    it("clears the speaking indicator when a participant stops talking", () => {
        const participants = [{ userId: "@alice:example.org", name: "Alice", isSpeaking: true }];
        const { rerender } = render(<DesktopVoiceParticipantSpeaking callParticipants={participants} />);
        expect(screen.getByRole("button", { name: "Alice (speaking)" })).toHaveAttribute("data-speaking", "true");

        rerender(<DesktopVoiceParticipantSpeaking callParticipants={[{ ...participants[0], isSpeaking: false }]} />);
        expect(screen.getByRole("button", { name: "Alice" })).not.toHaveAttribute("data-speaking");
    });

    it.each(["text", "voice"] as const)("renders a %s channel without a message preview or profile avatar", (kind) => {
        render(<Default channelKind={kind} renderAvatar={() => <span>Profile avatar</span>} />);
        expect(screen.getByRole("option", { name: "Open room General" })).toBeVisible();
        expect(screen.queryByText("Profile avatar")).not.toBeInTheDocument();
        expect(screen.queryByText("Alice: Hey everyone!")).not.toBeInTheDocument();
    });

    it("renders Default story", () => {
        const { container } = render(<Default />);
        expect(container).toMatchSnapshot();
    });

    it("renders Selected story", () => {
        const { container } = render(<Selected />);
        expect(container).toMatchSnapshot();
    });

    it("renders Bold story", () => {
        const { container } = render(<Bold />);
        expect(container).toMatchSnapshot();
    });

    it("renders WithNotification story", () => {
        const { container } = render(<WithNotification />);
        expect(container).toMatchSnapshot();
    });

    it("renders WithMention story", () => {
        const { container } = render(<WithMention />);
        expect(container).toMatchSnapshot();
    });

    it("renders WithVoiceCall story", () => {
        const { container } = render(<WithVoiceCall />);
        expect(container).toMatchSnapshot();
    });

    it("renders WithVideoCall story", () => {
        const { container } = render(<WithVideoCall />);
        expect(container).toMatchSnapshot();
    });

    it("renders Invitation story", () => {
        const { container } = render(<Invitation />);
        expect(container).toMatchSnapshot();
    });

    it("renders UnsentMessage story", () => {
        const { container } = render(<UnsentMessage />);
        expect(container).toMatchSnapshot();
    });

    it("renders NoMessagePreview story", () => {
        const { container } = render(<NoMessagePreview />);
        expect(container).toMatchSnapshot();
    });

    it("renders WithHoverMenu story", () => {
        const { container } = render(<WithHoverMenu />);
        expect(container).toMatchSnapshot();
    });

    it("should call onOpenRoom when clicked", async () => {
        const user = userEvent.setup();
        render(<Default />);

        await user.click(screen.getByRole("option"));
        expect(Default.args.onOpenRoom).toHaveBeenCalled();
    });

    it("should have aria-selected true when selected", () => {
        render(<Selected />);
        expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
    });

    it("should have aria-selected false when not selected", () => {
        render(<Default />);
        expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "false");
    });

    it("should have tabIndex -1 when not focused", () => {
        render(<Default />);
        expect(screen.getByRole("option")).toHaveAttribute("tabIndex", "-1");
    });

    it("should call onFocus when focused", () => {
        render(<Default />);
        screen.getByRole("option").focus();
        expect(Default.args.onFocus).toHaveBeenCalled();
    });

    it("should display notification decoration when present", () => {
        render(<WithNotification />);
        expect(screen.getByTestId("notification-decoration")).toBeInTheDocument();
    });

    it("should hide notification decoration when not present", () => {
        render(<Default />);
        expect(screen.queryByTestId("notification-decoration")).toBeNull();
    });

    it("should show hover menu when showMoreOptionsMenu is true", () => {
        const { container } = render(<WithHoverMenu />);
        expect(container.querySelector('[aria-label="More Options"]')).not.toBeNull();
    });

    it("should hide hover menu when showMoreOptionsMenu is false", () => {
        const { container } = render(<WithoutHoverMenu />);
        expect(container.querySelector('[aria-label="More Options"]')).toBeNull();
    });

    it("reveals the hover menu on keyboard focus and clears it when focus leaves", async () => {
        // isFocused focuses the row via the keyboard on mount, so the hover menu is revealed.
        const { container } = render(<WithHoverMenu isFocused={true} />);
        const option = screen.getByRole("option");
        const moreButton = container.querySelector('[aria-label="More Options"]');

        expect(option.className).toMatch(/keyboardActive/);
        expect(moreButton).toBeVisible();

        // Focus leaving the row hides the menu again.
        option.blur();
        await waitFor(() => expect(option.className).not.toMatch(/keyboardActive/));
        expect(moreButton).not.toBeVisible();
    });
});
