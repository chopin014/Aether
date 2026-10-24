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
    DesktopVoiceVideoSettingsView,
    desktopVoiceVideoSectionId,
    type DesktopVoiceVideoSettingsViewActions,
    type DesktopVoiceVideoSettingsViewSnapshot,
} from "./DesktopVoiceVideoSettingsView";
import { MockViewModel } from "../../core/viewmodel";

const baseSnapshot: DesktopVoiceVideoSettingsViewSnapshot = {
    devicesVisible: true,
    audioInputs: [
        { id: "default", label: "System default" },
        { id: "mic-2", label: "USB mic" },
    ],
    audioOutputs: [{ id: "default", label: "System default" }],
    videoInputs: [{ id: "cam-1", label: "Webcam" }],
    audioInputId: "default",
    audioOutputId: "default",
    videoInputId: "cam-1",
    microphoneVolume: 80,
    speakerVolume: 60,
    microphoneTest: { active: false, level: null, open: false },
    inputProfile: "custom",
    sensitivityAuto: true,
    sensitivity: -50,
    inputMode: "voice_activity",
    pushToTalk: { key: "Ctrl + V", recording: false, releaseDelay: 200, soundEnabled: true },
    echoCancellation: true,
    autoGainControl: true,
    voiceChannelSwitchWarning: false,
    videoTest: { active: false, stream: null },
    mirrorVideo: true,
    alwaysPreviewVideo: false,
    sounds: [
        { id: "mute", label: "Mute", enabled: true, extra: false },
        { id: "join", label: "Join", enabled: false, extra: false },
        { id: "cameraOn", label: "Camera on", enabled: true, extra: true },
        { id: "cameraOff", label: "Camera off", enabled: true, extra: true },
    ],
    inCall: false,
};

function makeVm(snapshot: Partial<DesktopVoiceVideoSettingsViewSnapshot> = {}) {
    const actions: DesktopVoiceVideoSettingsViewActions = {
        requestPermissions: vi.fn(),
        setAudioInput: vi.fn(),
        setAudioOutput: vi.fn(),
        setVideoInput: vi.fn(),
        setMicrophoneVolume: vi.fn(),
        setSpeakerVolume: vi.fn(),
        toggleMicrophoneTest: vi.fn(),
        setInputProfile: vi.fn(),
        setSensitivityAuto: vi.fn(),
        setSensitivity: vi.fn(),
        setInputMode: vi.fn(),
        toggleRecordingPushToTalk: vi.fn(),
        clearPushToTalk: vi.fn(),
        setPushToTalkReleaseDelay: vi.fn(),
        setPushToTalkSound: vi.fn(),
        setEchoCancellation: vi.fn(),
        setAutoGainControl: vi.fn(),
        setVoiceChannelSwitchWarning: vi.fn(),
        toggleVideoTest: vi.fn(),
        setMirrorVideo: vi.fn(),
        setAlwaysPreviewVideo: vi.fn(),
        setSoundEnabled: vi.fn(),
        previewSound: vi.fn(),
        openNotificationSettings: vi.fn(),
        setPeerToPeer: vi.fn(),
        setFallbackIceServer: vi.fn(),
        submitDebugLogs: vi.fn(),
        openHelp: vi.fn(),
        resetAll: vi.fn(),
    };
    return Object.assign(new MockViewModel({ ...baseSnapshot, ...snapshot }), actions);
}

describe("DesktopVoiceVideoSettingsView", () => {
    it("has the four sections the settings sidebar links to", () => {
        render(<DesktopVoiceVideoSettingsView vm={makeVm()} />);
        for (const [section, name] of [
            ["voice", "Voice"],
            ["video", "Video"],
            ["sounds", "Sounds"],
            ["advanced", "Advanced"],
        ] as const) {
            const heading = screen.getByRole("heading", { level: 2, name });
            expect(heading).toHaveAttribute("id", desktopVoiceVideoSectionId(section));
        }
    });

    it("offers no noise suppression, Krisp or voice isolation", () => {
        render(<DesktopVoiceVideoSettingsView vm={makeVm()} />);
        expect(screen.queryByText(/noise/i)).toBeNull();
        expect(screen.queryByText(/krisp|isolation/i)).toBeNull();
    });

    describe("voice", () => {
        it("chooses devices", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            await userEvent.selectOptions(screen.getByRole("combobox", { name: "Microphone" }), "mic-2");
            expect(vm.setAudioInput).toHaveBeenCalledWith("mic-2");
            expect(screen.getByRole("combobox", { name: "Speaker" })).toHaveValue("default");
        });

        it("asks for permission while device names are hidden", async () => {
            const vm = makeVm({ devicesVisible: false });
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            await userEvent.click(screen.getByRole("button", { name: "Allow access" }));
            expect(vm.requestPermissions).toHaveBeenCalledOnce();
        });

        it("sets the volumes", () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            const microphone = screen.getByRole("slider", { name: "Microphone volume" });
            expect(microphone).toHaveValue("80");
            expect(microphone).toHaveAttribute("aria-valuetext", "80%");
            fireEvent.change(microphone, { target: { value: "40" } });
            expect(vm.setMicrophoneVolume).toHaveBeenCalledWith(40);
            fireEvent.change(screen.getByRole("slider", { name: "Speaker volume" }), { target: { value: "20" } });
            expect(vm.setSpeakerVolume).toHaveBeenCalledWith(20);
        });

        it("starts and stops the microphone test and shows its level", async () => {
            const vm = makeVm();
            const { rerender } = render(<DesktopVoiceVideoSettingsView vm={vm} />);
            expect(screen.getByRole("meter", { name: "Microphone level" })).toHaveAttribute("aria-valuenow", "-100");
            await userEvent.click(screen.getByRole("button", { name: "Let's check" }));
            expect(vm.toggleMicrophoneTest).toHaveBeenCalledOnce();

            const testing = makeVm({ microphoneTest: { active: true, level: -30.4, open: true } });
            rerender(<DesktopVoiceVideoSettingsView vm={testing} />);
            expect(screen.getByRole("meter", { name: "Microphone level" })).toHaveAttribute("aria-valuenow", "-30");
            expect(screen.getByRole("button", { name: "Stop testing" })).toBeVisible();
            expect(screen.getByText(/hear yourself/)).toBeVisible();
        });

        it("explains why the microphone test could not start", () => {
            render(
                <DesktopVoiceVideoSettingsView
                    vm={makeVm({ microphoneTest: { active: false, level: null, open: false, error: "denied" } })}
                />,
            );
            expect(screen.getByRole("alert").textContent).toContain("Microphone access was blocked");
        });

        it("picks an input profile", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            const group = screen.getByRole("radiogroup", { name: "Input profile" });
            expect(within(group).getByRole("radio", { name: /Custom/ })).toBeChecked();
            await userEvent.click(within(group).getByRole("radio", { name: /Studio/ }));
            expect(vm.setInputProfile).toHaveBeenCalledWith("studio");
        });

        it("only lets the sensitivity be set by hand when it is not automatic", () => {
            const vm = makeVm();
            const { rerender } = render(<DesktopVoiceVideoSettingsView vm={vm} />);
            const slider = screen.getByRole("slider", { name: "Input sensitivity threshold" });
            expect(slider).toBeDisabled();
            rerender(<DesktopVoiceVideoSettingsView vm={makeVm({ sensitivityAuto: false })} />);
            expect(slider).toBeEnabled();
            expect(slider).toHaveAttribute("aria-valuetext", "-50 dB");
        });

        it("changes the sensitivity and shows the live level under it while testing", () => {
            const vm = makeVm({
                sensitivityAuto: false,
                microphoneTest: { active: true, level: -25, open: true },
            });
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            fireEvent.change(screen.getByRole("slider", { name: "Input sensitivity threshold" }), {
                target: { value: "-35" },
            });
            expect(vm.setSensitivity).toHaveBeenCalledWith(-35);
            expect(screen.getByTestId("sensitivity-level")).toHaveStyle({ width: "75%" });
        });

        it("switches between automatic and manual sensitivity", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            await userEvent.click(screen.getByRole("switch", { name: "Automatically determine input sensitivity" }));
            expect(vm.setSensitivityAuto).toHaveBeenCalledWith(false);
        });

        it("keeps the sensitivity controls off in the Studio profile", () => {
            render(<DesktopVoiceVideoSettingsView vm={makeVm({ inputProfile: "studio" })} />);
            expect(screen.getByRole("switch", { name: "Automatically determine input sensitivity" })).toBeDisabled();
            expect(screen.getByRole("slider", { name: "Input sensitivity threshold" })).toBeDisabled();
        });

        it("hides the push to talk controls in voice activity mode", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            expect(screen.queryByTestId("ptt-key")).toBeNull();
            await userEvent.click(screen.getByRole("radio", { name: "Push to talk" }));
            expect(vm.setInputMode).toHaveBeenCalledWith("push_to_talk");
        });

        describe("push to talk", () => {
            const pushToTalk = { inputMode: "push_to_talk" } as const;

            it("shows the key and records a new one", async () => {
                const vm = makeVm(pushToTalk);
                render(<DesktopVoiceVideoSettingsView vm={vm} />);
                expect(screen.getByTestId("ptt-key")).toHaveTextContent("Ctrl + V");
                expect(screen.getByText(/Manage keybinds in Keyboard settings/)).toBeVisible();
                await userEvent.click(screen.getByRole("button", { name: "Record keybind" }));
                expect(vm.toggleRecordingPushToTalk).toHaveBeenCalledOnce();
            });

            it("shows that a key is being recorded", () => {
                render(
                    <DesktopVoiceVideoSettingsView
                        vm={makeVm({
                            ...pushToTalk,
                            pushToTalk: { key: "", recording: true, releaseDelay: 200, soundEnabled: true },
                        })}
                    />,
                );
                expect(screen.getByTestId("ptt-key").textContent).toContain("Press a key");
                expect(screen.getByRole("button", { name: "Stop recording" })).toBeVisible();
            });

            it("explains that an unassigned push to talk key keeps the microphone closed", () => {
                render(
                    <DesktopVoiceVideoSettingsView
                        vm={makeVm({
                            ...pushToTalk,
                            pushToTalk: { key: "", recording: false, releaseDelay: 200, soundEnabled: true },
                        })}
                    />,
                );
                expect(screen.getByTestId("ptt-key")).toHaveTextContent("Not set");
                expect(screen.getByText(/Your microphone stays closed/)).toBeVisible();
                expect(screen.queryByRole("button", { name: "Clear keybind" })).toBeNull();
            });

            it("clears the key, sets the delay and the sound", async () => {
                const vm = makeVm(pushToTalk);
                render(<DesktopVoiceVideoSettingsView vm={vm} />);
                await userEvent.click(screen.getByRole("button", { name: "Clear keybind" }));
                expect(vm.clearPushToTalk).toHaveBeenCalledOnce();
                const delay = screen.getByRole("slider", { name: "Push to talk release delay" });
                expect(delay).toHaveAttribute("aria-valuetext", "200 ms");
                fireEvent.change(delay, { target: { value: "600" } });
                expect(vm.setPushToTalkReleaseDelay).toHaveBeenCalledWith(600);
                await userEvent.click(
                    screen.getByRole("switch", { name: "Play a sound when push to talk turns on or off" }),
                );
                expect(vm.setPushToTalkSound).toHaveBeenCalledWith(false);
            });
        });

        it("toggles echo cancellation", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            await userEvent.click(screen.getByRole("switch", { name: "Echo cancellation" }));
            expect(vm.setEchoCancellation).toHaveBeenCalledWith(false);
        });

        it("keeps automatic gain and the switch warning behind the advanced expander", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            const expander = screen.getByRole("button", { name: "Show advanced voice settings" });
            expect(expander).toHaveAttribute("aria-expanded", "false");
            expect(screen.queryByRole("switch", { name: "Automatic gain control" })).toBeNull();
            await userEvent.click(expander);
            expect(expander).toHaveAttribute("aria-expanded", "true");
            await userEvent.click(screen.getByRole("switch", { name: "Automatic gain control" }));
            expect(vm.setAutoGainControl).toHaveBeenCalledWith(false);
            await userEvent.click(screen.getByRole("switch", { name: "Voice channel switch warning" }));
            expect(vm.setVoiceChannelSwitchWarning).toHaveBeenCalledWith(true);
        });

        it("says when changes wait for the next call", () => {
            render(<DesktopVoiceVideoSettingsView vm={makeVm({ inCall: true })} />);
            expect(screen.getByText(/apply the next time you join a call/)).toBeVisible();
        });
    });

    describe("video", () => {
        it("chooses a camera and tests it", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            expect(screen.getByRole("combobox", { name: "Camera" })).toHaveValue("cam-1");
            expect(screen.getByText("Your camera preview appears here.")).toBeVisible();
            await userEvent.click(screen.getByRole("button", { name: "Test video" }));
            expect(vm.toggleVideoTest).toHaveBeenCalledOnce();
        });

        it("shows the camera stream, mirrored when asked", () => {
            const stream = new MediaStream();
            const { rerender } = render(
                <DesktopVoiceVideoSettingsView vm={makeVm({ videoTest: { active: true, stream } })} />,
            );
            const video = screen.getByLabelText("Camera preview") as HTMLVideoElement;
            expect(video.srcObject).toBe(stream);
            expect(video.className).toMatch(/mirrored/);
            expect(screen.getByRole("button", { name: "Stop test" })).toBeVisible();
            rerender(
                <DesktopVoiceVideoSettingsView
                    vm={makeVm({ mirrorVideo: false, videoTest: { active: true, stream } })}
                />,
            );
            expect((screen.getByLabelText("Camera preview") as HTMLVideoElement).className).not.toMatch(/mirrored/);
        });

        it("detaches the stream when the preview goes away", () => {
            const { unmount } = render(
                <DesktopVoiceVideoSettingsView
                    vm={makeVm({ videoTest: { active: true, stream: new MediaStream() } })}
                />,
            );
            const video = screen.getByLabelText("Camera preview") as HTMLVideoElement;
            unmount();
            expect(video.srcObject).toBeNull();
        });

        it("explains a blocked camera", () => {
            render(
                <DesktopVoiceVideoSettingsView
                    vm={makeVm({ videoTest: { active: false, stream: null, error: "denied" } })}
                />,
            );
            expect(screen.getByText(/Camera access was blocked/)).toBeVisible();
        });

        it("changes mirroring and the lobby preview", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            await userEvent.click(screen.getByRole("switch", { name: "Mirror my video" }));
            expect(vm.setMirrorVideo).toHaveBeenCalledWith(false);
            await userEvent.click(screen.getByRole("switch", { name: "Always preview video before joining" }));
            expect(vm.setAlwaysPreviewVideo).toHaveBeenCalledWith(true);
        });
    });

    describe("sounds", () => {
        it("lists the main sounds and toggles them", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            expect(screen.getByRole("switch", { name: "Mute" })).toBeChecked();
            expect(screen.getByRole("switch", { name: "Join" })).not.toBeChecked();
            expect(screen.queryByRole("switch", { name: "Camera on" })).toBeNull();
            await userEvent.click(screen.getByRole("switch", { name: "Join" }));
            expect(vm.setSoundEnabled).toHaveBeenCalledWith("join", true);
        });

        it("previews each sound by name", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            await userEvent.click(screen.getByRole("button", { name: "Preview sound: Join" }));
            expect(vm.previewSound).toHaveBeenCalledWith("join");
        });

        it("shows the other sounds on request", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            const more = screen.getByRole("button", { name: "Show 2 more sounds" });
            await userEvent.click(more);
            expect(screen.getByRole("switch", { name: "Camera on" })).toBeVisible();
            expect(screen.getByRole("button", { name: "Show fewer sounds" })).toBeVisible();
            await userEvent.click(screen.getByRole("switch", { name: "Camera off" }));
            expect(vm.setSoundEnabled).toHaveBeenCalledWith("cameraOff", false);
        });

        it("links to the notification settings", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            const links = screen.getAllByRole("button", { name: /Notifications/ });
            expect(links.length).toBeGreaterThan(0);
            for (const link of links) await userEvent.click(link);
            expect(vm.openNotificationSettings).toHaveBeenCalledTimes(links.length);
        });
    });

    describe("advanced", () => {
        it("shows peer-to-peer and the fallback server only where they apply", async () => {
            const vm = makeVm();
            const { rerender } = render(<DesktopVoiceVideoSettingsView vm={vm} />);
            expect(screen.queryByRole("switch", { name: /peer-to-peer/ })).toBeNull();
            expect(screen.queryByRole("switch", { name: /fallback call assist/ })).toBeNull();
            const full = makeVm({ peerToPeer: true, fallbackIceServer: false });
            rerender(<DesktopVoiceVideoSettingsView vm={full} />);
            await userEvent.click(screen.getByRole("switch", { name: /peer-to-peer/ }));
            expect(full.setPeerToPeer).toHaveBeenCalledWith(false);
            await userEvent.click(screen.getByRole("switch", { name: /fallback call assist/ }));
            expect(full.setFallbackIceServer).toHaveBeenCalledWith(true);
        });

        it("has no OpenH264 option", () => {
            render(<DesktopVoiceVideoSettingsView vm={makeVm()} />);
            expect(screen.queryByText(/openh264/i)).toBeNull();
        });

        it("offers the debug logs and Help & About under diagnostics", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            expect(screen.queryByRole("button", { name: "Submit debug logs" })).toBeNull();
            await userEvent.click(screen.getByRole("button", { name: "Show diagnostic settings" }));
            await userEvent.click(screen.getByRole("button", { name: "Submit debug logs" }));
            expect(vm.submitDebugLogs).toHaveBeenCalledOnce();
            await userEvent.click(screen.getByRole("button", { name: "Help & About" }));
            expect(vm.openHelp).toHaveBeenCalledOnce();
        });

        it("resets everything", async () => {
            const vm = makeVm();
            render(<DesktopVoiceVideoSettingsView vm={vm} />);
            await userEvent.click(screen.getByRole("button", { name: "Reset" }));
            expect(vm.resetAll).toHaveBeenCalledOnce();
        });
    });
});
