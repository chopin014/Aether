/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@test-utils";

import { AnimatedDeviceIcon, HangUpIcon, NoiseSuppressionIcon, ReactionIcon, ScreenShareIcon, SignalIcon } from ".";
import { SoundboardIcon } from "../SoundboardView";

describe("LiveIcons", () => {
    it.each([
        ["hang up", <HangUpIcon key="hang-up" />],
        ["noise suppression", <NoiseSuppressionIcon key="noise" />],
        ["reaction", <ReactionIcon key="reaction" />],
        ["screen share", <ScreenShareIcon key="share" />],
        ["signal", <SignalIcon key="signal" bars={4} />],
    ])("hides the %s icon from assistive technology", (_name, icon) => {
        const { container } = render(icon);
        expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    });

    it("passes a class name through to the icon", () => {
        const { container } = render(<HangUpIcon className="extra" />);
        expect(container.querySelector("svg")).toHaveClass("extra");
    });

    it.each([0, 2, 4] as const)("lights %i signal bars", (bars) => {
        const { container } = render(<SignalIcon bars={bars} />);
        const icon = container.querySelector("svg");
        expect(icon).toHaveAttribute("data-bars", String(bars));
        expect(icon?.querySelectorAll("rect")).toHaveLength(4);
        expect(icon).not.toHaveAttribute("data-pending");
    });

    it("marks a signal that is still connecting", () => {
        const { container } = render(<SignalIcon bars={2} pending />);
        expect(container.querySelector("svg")).toHaveAttribute("data-pending", "true");
    });

    it("draws the waveform as five separate bars so each can move", () => {
        const { container } = render(<NoiseSuppressionIcon />);
        expect(container.querySelectorAll("line")).toHaveLength(5);
    });

    it.each([
        ["screen share", () => <ScreenShareIcon />],
        ["reaction", () => <ReactionIcon />],
    ])("gives each %s icon its own mask", (_name, Icon) => {
        const { container } = render(
            <>
                <Icon />
                <Icon />
            </>,
        );
        const masks = [...container.querySelectorAll("mask")].map((mask) => mask.id);
        expect(new Set(masks).size).toBe(2);
        for (const id of masks) {
            expect(container.querySelector(`[mask="url(#${id})"]`)).not.toBeNull();
        }
    });

    it.each(["microphone", "headphones", "camera"] as const)("names the %s it draws", (device) => {
        const { container } = render(<AnimatedDeviceIcon device={device} off={false} />);
        const icon = container.firstElementChild;
        expect(icon).toHaveAttribute("data-device", device);
        expect(icon).toHaveAttribute("data-off", "false");
        expect(icon).toHaveAttribute("aria-hidden", "true");
    });

    it("animates a device only once it is switched, not as it first appears", () => {
        const { container, rerender } = render(<AnimatedDeviceIcon device="camera" off={true} />);
        expect(container.firstElementChild).not.toHaveAttribute("data-animate");
        rerender(<AnimatedDeviceIcon device="camera" off={false} />);
        expect(container.firstElementChild).toHaveAttribute("data-animate", "true");
    });

    it("keeps the soundboard popper's confetti and passes its props through", () => {
        const { container } = render(<SoundboardIcon aria-hidden="true" className="extra" />);
        const icon = container.querySelector("svg");
        expect(icon).toHaveAttribute("aria-hidden", "true");
        expect(icon).toHaveClass("extra");
        expect(icon?.querySelectorAll("circle")).toHaveLength(3);
    });
});
