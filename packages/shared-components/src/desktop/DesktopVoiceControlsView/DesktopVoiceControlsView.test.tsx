/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopVoiceControlsView,
    DesktopVoiceConnectionView,
    type DesktopVoiceControlsViewSnapshot,
} from "./DesktopVoiceControlsView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DesktopVoiceControlsViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopVoiceControlsViewSnapshot>({
            microphoneMuted: false,
            deafened: false,
            videoEnabled: false,
            screenShareAvailable: true,
            screenSharing: false,
            busy: false,
            ...snapshot,
        }),
        {
            toggleMicrophone: vi.fn(),
            toggleDeafened: vi.fn(),
            toggleVideo: vi.fn(),
            toggleScreenShare: vi.fn(),
            disconnect: vi.fn(),
            showCall: vi.fn(),
        },
    );
}
describe("DesktopVoiceControlsView", () => {
    it("calls the actual microphone and deafen actions", async () => {
        const vm = makeVm();
        render(<DesktopVoiceControlsView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Mute" }));
        expect(vm.toggleMicrophone).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Deafen" }));
        expect(vm.toggleDeafened).toHaveBeenCalledOnce();
    });
    it("shows current device state and prevents overlapping device changes", () => {
        render(<DesktopVoiceControlsView vm={makeVm({ microphoneMuted: true, deafened: true, busy: true })} />);
        expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Undeafen" })).toBeDisabled();
    });
    it("shows only an actual connected call and keeps navigation, media and hang-up available", async () => {
        const vm = makeVm({ roomName: "Lounge" });
        render(<DesktopVoiceConnectionView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Voice Connected Lounge" }));
        expect(vm.showCall).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Turn on camera" }));
        expect(vm.toggleVideo).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Share your screen" }));
        expect(vm.toggleScreenShare).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
        expect(vm.disconnect).toHaveBeenCalledOnce();
    });
    it("shows the camera and screen share that are on, and hides screen sharing the call cannot do", () => {
        const { unmount } = render(
            <DesktopVoiceConnectionView vm={makeVm({ roomName: "Lounge", videoEnabled: true, screenSharing: true })} />,
        );
        expect(screen.getByRole("button", { name: "Turn off camera" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Stop sharing your screen" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        unmount();
        render(<DesktopVoiceConnectionView vm={makeVm({ roomName: "Lounge", screenShareAvailable: false })} />);
        expect(screen.queryByRole("button", { name: "Share your screen" })).not.toBeInTheDocument();
    });
    it("omits a disconnected call and displays actionable errors", () => {
        const { unmount } = render(<DesktopVoiceConnectionView vm={makeVm()} />);
        expect(screen.queryByText("Voice Connected")).not.toBeInTheDocument();
        unmount();
        render(<DesktopVoiceConnectionView vm={makeVm({ error: "Microphone disconnected" })} />);
        expect(screen.getByRole("alert")).toHaveTextContent("Microphone disconnected");
    });
});
