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
            busy: false,
            ...snapshot,
        }),
        {
            toggleMicrophone: vi.fn(),
            toggleDeafened: vi.fn(),
            disconnect: vi.fn(),
            showCall: vi.fn(),
            openAudioSettings: vi.fn(),
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
    it("shows only an actual connected call and keeps navigation, settings and hang-up available", async () => {
        const vm = makeVm({ roomName: "Lounge" });
        render(<DesktopVoiceConnectionView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Voice Connected Lounge" }));
        expect(vm.showCall).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Voice & Video settings" }));
        expect(vm.openAudioSettings).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
        expect(vm.disconnect).toHaveBeenCalledOnce();
    });
    it("omits a disconnected call and displays actionable errors", () => {
        const { unmount } = render(<DesktopVoiceConnectionView vm={makeVm()} />);
        expect(screen.queryByText("Voice Connected")).not.toBeInTheDocument();
        unmount();
        render(<DesktopVoiceConnectionView vm={makeVm({ error: "Microphone disconnected" })} />);
        expect(screen.getByRole("alert")).toHaveTextContent("Microphone disconnected");
    });
});
