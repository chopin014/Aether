/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { MicrophoneSettingsView, type MicrophoneSettingsViewSnapshot } from "./MicrophoneSettingsView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<MicrophoneSettingsViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<MicrophoneSettingsViewSnapshot>({
            microphones: [
                { id: "mic", label: "Built-in microphone" },
                { id: "usb", label: "USB microphone" },
            ],
            speakers: [
                { id: "speaker", label: "System speakers" },
                { id: "headphones", label: "Headphones" },
            ],
            microphoneId: "mic",
            speakerId: "speaker",
            inputVolume: 100,
            testVolume: 50,
            automaticSensitivity: true,
            sensitivityDb: -50,
            levelDb: -100,
            effectiveThresholdDb: -50,
            voiceDetected: false,
            testing: false,
            starting: false,
            error: null,
            canSelectOutput: true,
            ...snapshot,
        }),
        {
            setMicrophone: vi.fn(),
            setSpeaker: vi.fn(),
            setInputVolume: vi.fn(),
            setTestVolume: vi.fn(),
            setAutomaticSensitivity: vi.fn(),
            setSensitivityDb: vi.fn(),
            toggleTest: vi.fn(),
        },
    );
}

describe("MicrophoneSettingsView", () => {
    it("should display saved preferences without activating microphone access or playback", () => {
        const vm = makeVm({ levelDb: -10, voiceDetected: true });
        render(<MicrophoneSettingsView vm={vm} />);

        expect(screen.getByRole("region", { name: "Microphone settings" })).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: "Input device" })).toHaveValue("mic");
        expect(screen.getByRole("slider", { name: "Input volume" })).toHaveValue("100");
        expect(screen.getByRole("slider", { name: "Input volume" })).toHaveAttribute("aria-valuetext", "100%");
        expect(screen.getByRole("slider", { name: "Input volume" })).toHaveAttribute("max", "200");
        expect(screen.getByRole("slider", { name: "Test playback volume" })).toHaveValue("50");
        expect(screen.getByRole("slider", { name: "Test playback volume" })).toHaveAttribute("max", "100");
        expect(screen.getByRole("meter", { name: "Microphone level" })).toHaveAttribute("aria-valuenow", "-100");
        expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "Inactive");
        expect(screen.getByRole("meter")).toHaveAttribute("data-active", "false");
        expect(screen.getByRole("meter")).toHaveAttribute("data-voice-detected", "false");
        expect(screen.getByRole("status")).toHaveTextContent("Start a mic test to check your level.");
        expect(screen.getByRole("button", { name: "Mic test" })).toHaveAccessibleDescription(/Use headphones/);
        expect(screen.queryByRole("slider", { name: "Manual sensitivity" })).not.toBeInTheDocument();
        expect(vm.toggleTest).not.toHaveBeenCalled();
        expect(vm.setMicrophone).not.toHaveBeenCalled();
    });

    it("should forward device selection and numeric volume changes to the host", async () => {
        const vm = makeVm();
        render(<MicrophoneSettingsView vm={vm} />);

        await userEvent.selectOptions(screen.getByRole("combobox", { name: "Input device" }), "usb");
        await userEvent.selectOptions(screen.getByRole("combobox", { name: "Test output device" }), "headphones");
        fireEvent.change(screen.getByRole("slider", { name: "Input volume" }), { target: { value: "175" } });
        fireEvent.change(screen.getByRole("slider", { name: "Test playback volume" }), { target: { value: "25" } });
        await userEvent.click(screen.getByRole("button", { name: "Mic test" }));

        expect(vm.setMicrophone).toHaveBeenCalledWith("usb");
        expect(vm.setSpeaker).toHaveBeenCalledWith("headphones");
        expect(vm.setInputVolume).toHaveBeenCalledWith(175);
        expect(vm.setTestVolume).toHaveBeenCalledWith(25);
        expect(vm.toggleTest).toHaveBeenCalledOnce();
    });

    it("should let the keyboard toggle automatic sensitivity", async () => {
        const vm = makeVm();
        render(<MicrophoneSettingsView vm={vm} />);
        const toggle = screen.getByRole("switch", { name: "Automatically determine input sensitivity" });

        expect(toggle).toBeChecked();
        toggle.focus();
        await userEvent.keyboard(" ");
        expect(vm.setAutomaticSensitivity).toHaveBeenCalledWith(false);
    });

    it("should expose the manual threshold range, units and direction guidance", () => {
        const vm = makeVm({ automaticSensitivity: false, sensitivityDb: -60 });
        render(<MicrophoneSettingsView vm={vm} />);
        const slider = screen.getByRole("slider", { name: "Manual sensitivity" });

        expect(slider).toHaveAttribute("min", "-100");
        expect(slider).toHaveAttribute("max", "0");
        expect(slider).toHaveAttribute("aria-valuetext", "-60 dB");
        expect(slider).toHaveAccessibleDescription(/Move left for more sensitivity.*Move right/);
        fireEvent.change(slider, { target: { value: "-35" } });
        expect(vm.setSensitivityDb).toHaveBeenCalledWith(-35);
    });

    it("should show live processed levels and allow stopping the test", async () => {
        const vm = makeVm({ testing: true, levelDb: -22, effectiveThresholdDb: -45, voiceDetected: true });
        render(<MicrophoneSettingsView vm={vm} />);
        const meter = screen.getByRole("meter", { name: "Microphone level" });

        expect(meter).toHaveAttribute("aria-valuemin", "-100");
        expect(meter).toHaveAttribute("aria-valuemax", "0");
        expect(meter).toHaveAttribute("aria-valuenow", "-22");
        expect(meter).toHaveAttribute("aria-valuetext", "-22 dB");
        expect(meter).toHaveAccessibleDescription("Threshold: -45 dB");
        expect(meter).toHaveAttribute("data-voice-detected", "true");
        expect(screen.getByRole("status")).toHaveTextContent("Voice detected");
        await userEvent.click(screen.getByRole("button", { name: "Stop test" }));
        expect(vm.toggleTest).toHaveBeenCalledOnce();
    });

    it("should distinguish a quiet signal from detected voice", () => {
        render(<MicrophoneSettingsView vm={makeVm({ testing: true, levelDb: -70 })} />);
        expect(screen.getByRole("meter")).toHaveAttribute("data-active", "true");
        expect(screen.getByRole("meter")).toHaveAttribute("data-voice-detected", "false");
        expect(screen.getByRole("status")).toHaveTextContent("Below the sensitivity threshold");
    });

    it("should represent pending permission and prevent duplicate starts or device changes", async () => {
        const vm = makeVm({ starting: true });
        render(<MicrophoneSettingsView vm={vm} />);
        const button = screen.getByRole("button", { name: "Starting…" });

        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-busy", "true");
        expect(screen.getByRole("combobox", { name: "Input device" })).toBeDisabled();
        expect(screen.getByRole("combobox", { name: "Test output device" })).toBeDisabled();
        expect(screen.getByRole("status")).toHaveTextContent("Waiting for microphone access…");
        await userEvent.click(button);
        expect(vm.toggleTest).not.toHaveBeenCalled();
    });

    it("should announce a permission error and offer an explicit retry", async () => {
        const vm = makeVm({ error: "Allow microphone access in your browser and try again." });
        render(<MicrophoneSettingsView vm={vm} />);

        expect(screen.getByRole("alert")).toHaveTextContent("Allow microphone access in your browser and try again.");
        expect(screen.getByRole("meter")).toHaveAttribute("data-active", "false");
        await userEvent.click(screen.getByRole("button", { name: "Mic test" }));
        expect(vm.toggleTest).toHaveBeenCalledOnce();
    });

    it.each([{ canSelectOutput: false }, { speakers: [] }])(
        "should explain system output when an output selector is unavailable: %j",
        (snapshot) => {
            render(<MicrophoneSettingsView vm={makeVm(snapshot)} />);

            expect(screen.queryByRole("combobox", { name: "Test output device" })).not.toBeInTheDocument();
            expect(screen.getByText("The mic test uses your system output device.")).toBeInTheDocument();
            expect(screen.getByRole("slider", { name: "Test playback volume" })).toBeEnabled();
        },
    );

    it("should keep a mic test available before device permission reveals device choices", () => {
        render(<MicrophoneSettingsView vm={makeVm({ microphones: [], speakers: [] })} />);

        expect(screen.getByRole("combobox", { name: "Input device" })).toBeDisabled();
        expect(screen.getByRole("option", { name: "System default" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Mic test" })).toBeEnabled();
    });
});
