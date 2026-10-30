/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopVoiceControlsView,
    DesktopVoiceConnectionView,
    type DesktopVoiceControlsViewSnapshot,
} from "./DesktopVoiceControlsView";
import type { SoundboardViewSnapshot } from "../SoundboardView";
import { MockViewModel } from "../../core/viewmodel";
import { VoicePopover } from "./VoicePopover";

function makeVm(snapshot: Partial<DesktopVoiceControlsViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopVoiceControlsViewSnapshot>({
            microphoneMuted: false,
            deafened: false,
            videoEnabled: false,
            screenShareAvailable: true,
            screenSharing: false,
            busy: false,
            panel: null,
            noiseSuppression: true,
            noiseSuppressionStrength: 100,
            microphoneTest: { active: false, level: null, open: false },
            audioInputs: [
                { id: "", label: "Default" },
                { id: "headset", label: "USB Headset Microphone" },
            ],
            audioOutputs: [
                { id: "", label: "Default" },
                { id: "speakers", label: "Desk Speakers" },
            ],
            audioInputId: "",
            audioOutputId: "speakers",
            microphoneVolume: 100,
            speakerVolume: 80,
            connection: {
                state: "connected",
                quality: "good",
                rttMs: 17,
                averageRttMs: 19,
                outboundPacketLossPercent: 0,
                history: [20, 18, 19, 17],
            },
            ...snapshot,
        }),
        {
            toggleMicrophone: vi.fn(),
            toggleDeafened: vi.fn(),
            toggleVideo: vi.fn(),
            toggleScreenShare: vi.fn(),
            disconnect: vi.fn(),
            showCall: vi.fn(),
            setPanel: vi.fn(),
            setNoiseSuppression: vi.fn(),
            setNoiseSuppressionStrength: vi.fn(),
            toggleMicrophoneTest: vi.fn(),
            setAudioInput: vi.fn(),
            setAudioOutput: vi.fn(),
            setMicrophoneVolume: vi.fn(),
            setSpeakerVolume: vi.fn(),
            openVoiceSettings: vi.fn(),
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
    it("animates the slash through a device only when it is muted or unmuted after the dock appears", () => {
        const { container, rerender } = render(<DesktopVoiceControlsView vm={makeVm({ microphoneMuted: true })} />);
        const [microphone, headphones] = container.querySelectorAll("[data-off]");
        expect(microphone).toHaveAttribute("data-off", "true");
        expect(headphones).toHaveAttribute("data-off", "false");
        expect(container.querySelector("[data-animate]")).toBeNull();

        rerender(<DesktopVoiceControlsView vm={makeVm({ microphoneMuted: false, deafened: true })} />);
        expect(microphone).toHaveAttribute("data-off", "false");
        expect(microphone).toHaveAttribute("data-animate", "true");
        expect(headphones).toHaveAttribute("data-animate", "true");
        // The device and its menu share the muted colour.
        expect(screen.getByRole("button", { name: "Undeafen" }).parentElement).toHaveAttribute("data-muted", "true");
    });
    it("opens a menu for each device from the arrow beside it", async () => {
        const vm = makeVm();
        render(<DesktopVoiceControlsView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Input options" }));
        expect(vm.setPanel).toHaveBeenCalledWith("input");
        await userEvent.click(screen.getByRole("button", { name: "Output options" }));
        expect(vm.setPanel).toHaveBeenCalledWith("output");
    });
    it("chooses the microphone and its volume from the input menu", async () => {
        const vm = makeVm({ panel: "input" });
        render(<DesktopVoiceControlsView vm={vm} />);
        const menu = screen.getByRole("dialog", { name: "Input options" });
        expect(screen.getByRole("button", { name: "Input options" })).toHaveAttribute("aria-expanded", "true");
        await userEvent.selectOptions(within(menu).getByRole("combobox", { name: "Input device" }), "headset");
        expect(vm.setAudioInput).toHaveBeenCalledWith("headset");
        fireEvent.change(within(menu).getByRole("slider", { name: "Input volume" }), { target: { value: "60" } });
        expect(vm.setMicrophoneVolume).toHaveBeenCalledWith(60);
        await userEvent.click(within(menu).getByRole("button", { name: "Voice settings" }));
        expect(vm.openVoiceSettings).toHaveBeenCalledOnce();
    });
    it("chooses the speaker and its volume from the output menu", async () => {
        const vm = makeVm({ panel: "output" });
        render(<DesktopVoiceControlsView vm={vm} />);
        const menu = screen.getByRole("dialog", { name: "Output options" });
        const speaker = within(menu).getByRole("combobox", { name: "Output device" });
        expect(speaker).toHaveValue("speakers");
        expect(within(menu).getByText("80%")).toBeVisible();
        await userEvent.selectOptions(speaker, "");
        expect(vm.setAudioOutput).toHaveBeenCalledWith("");
        fireEvent.change(within(menu).getByRole("slider", { name: "Output volume" }), { target: { value: "35" } });
        expect(vm.setSpeakerVolume).toHaveBeenCalledWith(35);
    });
    it("leaves the device menus to the account row, not the connected call", () => {
        render(<DesktopVoiceConnectionView vm={makeVm({ roomName: "Lounge", panel: "input" })} />);
        expect(screen.queryByRole("dialog")).toBeNull();
    });
    it("shows only an actual connected call and keeps navigation, media and hang-up available", async () => {
        const vm = makeVm({ roomName: "Lounge" });
        render(<DesktopVoiceConnectionView vm={vm} />);
        const call = screen.getByRole("button", { name: "Voice Connected Lounge" });
        // Chromium excludes nested live status text from the button's implicit accessible name.
        expect(call).toHaveAttribute("aria-label", "Voice Connected Lounge");
        await userEvent.click(call);
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

    it("opens quick suppression and connection panels without navigating away from the channel", async () => {
        const vm = makeVm({ roomName: "Lounge" });
        render(<DesktopVoiceConnectionView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Advanced noise suppression" }));
        expect(vm.setPanel).toHaveBeenLastCalledWith("noise");
        await userEvent.click(screen.getByRole("button", { name: "Connection" }));
        expect(vm.setPanel).toHaveBeenLastCalledWith("connection");
        expect(vm.showCall).not.toHaveBeenCalled();
    });

    it("edits the 0–100 suppression strength and starts the processed microphone test", async () => {
        const vm = makeVm({ roomName: "Lounge", panel: "noise", noiseSuppressionStrength: 80 });
        render(<DesktopVoiceConnectionView vm={vm} />);
        expect(screen.getByRole("dialog", { name: "Advanced noise suppression" })).toBeVisible();
        expect(screen.getByText("80%")).toBeVisible();
        const slider = screen.getByRole("slider", { name: "Suppression strength" });
        expect(slider).toHaveAttribute("min", "0");
        expect(slider).toHaveAttribute("max", "100");
        fireEvent.change(slider, { target: { value: "35" } });
        expect(vm.setNoiseSuppressionStrength).toHaveBeenCalledWith(35);
        await userEvent.click(screen.getByRole("switch", { name: "Noise suppression" }));
        expect(vm.setNoiseSuppression).toHaveBeenCalledWith(false);
        await userEvent.click(screen.getByRole("button", { name: "Let's check" }));
        expect(vm.toggleMicrophoneTest).toHaveBeenCalledOnce();
        expect(screen.getByRole("meter", { name: "Microphone level" })).toHaveAttribute("aria-valuenow", "-100");
    });

    it("keeps the chosen strength visible while suppression is off", () => {
        render(
            <DesktopVoiceConnectionView
                vm={makeVm({
                    roomName: "Lounge",
                    panel: "noise",
                    noiseSuppression: false,
                    noiseSuppressionStrength: 80,
                })}
            />,
        );
        expect(screen.getByRole("slider", { name: "Suppression strength" })).toBeDisabled();
        expect(screen.getByText("80%")).toBeVisible();
    });

    it("keeps the strength slider usable while a setting is being saved", () => {
        const vm = makeVm({ roomName: "Lounge", panel: "noise", busy: true });
        render(<DesktopVoiceConnectionView vm={vm} />);
        const slider = screen.getByRole("slider", { name: "Suppression strength" });
        expect(slider).toBeEnabled();
        fireEvent.change(slider, { target: { value: "60" } });
        expect(vm.setNoiseSuppressionStrength).toHaveBeenCalledWith(60);
    });

    it("shows the processed live level and an explicit stop-test control", async () => {
        const vm = makeVm({
            roomName: "Lounge",
            panel: "noise",
            microphoneTest: { active: true, level: -24, open: true },
        });
        render(<DesktopVoiceConnectionView vm={vm} />);
        expect(screen.getByRole("meter", { name: "Microphone level" })).toHaveAttribute("aria-valuenow", "-24");
        await userEvent.click(screen.getByRole("button", { name: "Stop testing" }));
        expect(vm.toggleMicrophoneTest).toHaveBeenCalledOnce();
    });

    it("explains microphone access and suppression failures in the quick panel", () => {
        render(
            <DesktopVoiceConnectionView
                vm={makeVm({
                    roomName: "Lounge",
                    panel: "noise",
                    noiseSuppressionProblem: "overloaded",
                    microphoneTest: { active: false, level: null, open: false, error: "denied" },
                })}
            />,
        );
        expect(screen.getByText(/this computer could not keep up/)).toHaveAttribute("role", "alert");
        expect(screen.getByText(/Microphone access was blocked/)).toHaveAttribute("role", "alert");
    });

    it("shows measured ping and packet loss instead of connection estimates", () => {
        render(<DesktopVoiceConnectionView vm={makeVm({ roomName: "Lounge", panel: "connection" })} />);
        expect(screen.getByRole("dialog", { name: "Connection" })).toBeVisible();
        expect(screen.getByText("19 ms")).toBeVisible();
        expect(screen.getByText("17 ms")).toBeVisible();
        expect(screen.getByText("0.0%")).toBeVisible();
        expect(screen.getByRole("img", { name: "Recent ping" })).toBeVisible();
        expect(screen.queryByText(/Waiting for connection statistics/)).not.toBeInTheDocument();
    });

    it("shows missing measurements as unavailable and breaks the graph across a gap", () => {
        render(
            <DesktopVoiceConnectionView
                vm={makeVm({
                    roomName: "Lounge",
                    panel: "connection",
                    connection: {
                        state: "connected",
                        quality: "unknown",
                        rttMs: null,
                        averageRttMs: null,
                        outboundPacketLossPercent: null,
                        history: [20, 22, null, 25, 28],
                    },
                })}
            />,
        );
        expect(screen.getAllByText("—")).toHaveLength(3);
        expect(screen.getByText("Waiting for connection statistics…")).toBeVisible();
        expect(screen.getByRole("img", { name: "Recent ping" }).querySelectorAll("polyline")).toHaveLength(2);
    });

    it.each([
        ["connecting", "unknown", "Connecting…", "warning"],
        ["reconnecting", "unknown", "Reconnecting…", "warning"],
        ["connected", "poor", "Poor connection", "warning"],
        ["connected", "bad", "Very poor connection", "critical"],
        ["disconnected", "lost", "Disconnected", "critical"],
        ["connected", "unknown", "Voice Connected", "neutral"],
    ] as const)("shows %s/%s visibly and through a live status", (state, quality, label, tone) => {
        const base = makeVm().getSnapshot().connection;
        render(
            <DesktopVoiceConnectionView vm={makeVm({ roomName: "Lounge", connection: { ...base, state, quality } })} />,
        );
        expect(screen.getByRole("status")).toHaveTextContent(label);
        expect(screen.getByRole("status").closest("[data-tone]")).toHaveAttribute("data-tone", tone);
    });

    it("explains impaired audio when the call reports poor quality", () => {
        const base = makeVm().getSnapshot().connection;
        render(
            <DesktopVoiceConnectionView
                vm={makeVm({ roomName: "Lounge", panel: "connection", connection: { ...base, quality: "poor" } })}
            />,
        );
        expect(screen.getByText(/Packet loss can make voices sound robotic/)).toBeVisible();
    });

    it("dismisses with Escape and returns focus to the panel's trigger", async () => {
        const vm = makeVm({ roomName: "Lounge", panel: "noise" });
        render(<DesktopVoiceConnectionView vm={vm} />);
        expect(screen.getByRole("dialog")).toHaveFocus();
        await userEvent.keyboard("{Escape}");
        expect(vm.setPanel).toHaveBeenCalledWith(null);
        expect(screen.getByRole("button", { name: "Advanced noise suppression" })).toHaveFocus();
    });

    it("dismisses on an outside click and exposes a close button", async () => {
        const vm = makeVm({ roomName: "Lounge", panel: "connection" });
        render(<DesktopVoiceConnectionView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(vm.setPanel).toHaveBeenCalledWith(null);
        vm.setPanel.mockClear();
        fireEvent.pointerDown(document.body);
        expect(vm.setPanel).toHaveBeenCalledWith(null);
    });
});

it.each(["change", "cancel"])("preserves the file picker until %s and restores focus inside the panel", (eventType) => {
    const anchor = React.createRef<HTMLButtonElement>();
    const close = vi.fn();
    render(
        <>
            <button ref={anchor}>Soundboard</button>
            <input aria-label="Message composer" />
            <VoicePopover anchor={anchor} title="Soundboard" onClose={close}>
                <input type="file" aria-label="Choose audio" />
            </VoicePopover>
        </>,
    );
    const file = screen.getByLabelText("Choose audio");
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.click(file);
    composer.focus();
    expect(close).not.toHaveBeenCalled();
    fireEvent(file, new Event(eventType, { bubbles: true }));
    expect(screen.getByRole("dialog")).toHaveFocus();
    composer.focus();
    expect(close).toHaveBeenCalledOnce();
});

it("opens the full dock soundboard and plays a sound", async () => {
    const soundboard = Object.assign(
        new MockViewModel<SoundboardViewSnapshot>({
            query: "",
            libraries: [],
            suggested: [{ id: "quack", name: "Quack", emoji: "🦆", libraryId: "builtin" }],
            volume: 80,
            busy: false,
            uploadLibraryId: "",
            uploadName: "",
            uploadEmoji: "🔊",
        }),
        {
            open: vi.fn(),
            setLibrary: vi.fn(),
            setQuery: vi.fn(),
            setVolume: vi.fn(),
            play: vi.fn(),
            setUploadLibrary: vi.fn(),
            setUploadName: vi.fn(),
            setUploadEmoji: vi.fn(),
            upload: vi.fn(),
            edit: vi.fn(),
            setClipVolume: vi.fn(),
            setClipRange: vi.fn(),
            previewClip: vi.fn(),
            stopClipPreview: vi.fn(),
            cancelClip: vi.fn(),
            saveClip: vi.fn(),
            remove: vi.fn(),
        },
    );
    const vm = makeVm({ roomName: "Lounge", soundboard, panel: "soundboard" });
    render(<DesktopVoiceConnectionView vm={vm} />);
    expect(screen.getByRole("button", { name: "Soundboard" })).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Soundboard" });
    expect(within(dialog).getByRole("searchbox")).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Quack" }));
    expect(soundboard.play).toHaveBeenCalledOnce();
});
