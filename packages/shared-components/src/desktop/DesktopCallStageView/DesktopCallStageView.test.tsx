/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@test-utils";

import type { SoundboardViewSnapshot } from "../SoundboardView";
import { BaseViewModel, MockViewModel } from "../../core/viewmodel";
import {
    DesktopCallStageView,
    type DesktopCallStageParticipantTile,
    type DesktopCallStageScreenShareTile,
    type DesktopCallStageVideoAttachment,
    type DesktopCallStageViewModel,
    type DesktopCallStageViewSnapshot,
} from "./DesktopCallStageView";

class TestCallStageViewModel
    extends BaseViewModel<DesktopCallStageViewSnapshot, Record<string, never>>
    implements DesktopCallStageViewModel
{
    public joinCall = vi.fn();
    public returnToLobby = vi.fn();
    public requestDevicePermissions = vi.fn();
    public toggleRaisedHand = vi.fn();
    public sendReaction = vi.fn();
    public dismissDeviceError = vi.fn();
    public leaveCall = vi.fn();
    public reconnect = vi.fn();
    public toggleLocalAudio = vi.fn();
    public toggleLocalVideo = vi.fn();
    public toggleScreenShare = vi.fn();
    public startScreenShareWithQuality = vi.fn();
    public updateScreenShareQuality = vi.fn();
    public dismissScreenShareError = vi.fn();
    public selectAudioInput = vi.fn();
    public selectAudioOutput = vi.fn();
    public selectVideoInput = vi.fn();
    public setActiveMenu = vi.fn((menu: DesktopCallStageViewSnapshot["activeMenu"]) =>
        this.snapshot.merge({ activeMenu: menu, openTileMenuId: null }),
    );
    public setOpenTileMenuId = vi.fn((id: string | null) =>
        this.snapshot.merge({ openTileMenuId: id, activeMenu: null }),
    );
    public setSpotlightTileId = vi.fn((id: string | null) =>
        this.snapshot.merge({ spotlightTileId: id, layoutMode: id ? "spotlight" : "grid" }),
    );
    public setLayoutMode = vi.fn((mode: DesktopCallStageViewSnapshot["layoutMode"]) =>
        this.snapshot.merge({ layoutMode: mode }),
    );
    public setParticipantMicrophoneVolume = vi.fn();
    public toggleParticipantMicrophoneMuted = vi.fn();
    public setScreenShareAudioVolume = vi.fn();
    public toggleScreenShareAudioMuted = vi.fn();
    public openInviteDialog = vi.fn();
    public showRoomChat = vi.fn();
    public toggleFullscreen = vi.fn();
    public renderAudioElement = () => <div data-testid="matrix-audio-renderer" />;

    public constructor(overrides: Partial<DesktopCallStageViewSnapshot> = {}) {
        super(
            {},
            {
                presentation: "channel",
                phase: "in_call",
                roomName: "General Voice",
                participantCount: 2,
                connected: true,
                reconnecting: false,
                encrypted: true,
                keyRotationSuppressed: false,
                localAudioEnabled: true,
                localVideoEnabled: false,
                localDeafened: false,
                sharingScreen: false,
                canShareScreen: true,
                miniMode: false,
                isFullscreen: false,
                layoutMode: "grid",
                spotlightTileId: null,
                activeMenu: null,
                openTileMenuId: null,
                audioInputDevices: [{ id: "mic-1", label: "Studio Mic", selected: true }],
                audioOutputDevices: [{ id: "spk-1", label: "Studio Monitors", selected: true }],
                videoInputDevices: [{ id: "cam-1", label: "HD Webcam", selected: true }],
                participants: [],
                screenShares: [],
                lobbyPreviewVideo: null,
                screenShareQuality: {
                    resolutionHeight: 1080,
                    frameRate: 30,
                    maxBitrate: null,
                    includeSystemAudio: true,
                },
                screenSharePolicyLimits: {
                    maxResolutionHeight: null,
                    maxFrameRate: null,
                    maxBitrate: null,
                },
                fatalError: null,
                screenShareError: null,
                deviceError: null,
                needsDevicePermissions: false,
                permissionError: null,
                supportsReactions: true,
                localHandRaised: false,
                ringing: null,
                callees: [],
                canShareSystemAudio: true,
                ...overrides,
            },
        );
    }

    public updateSnapshot(patch: Partial<DesktopCallStageViewSnapshot>): void {
        this.snapshot.merge(patch);
    }
}

function makeParticipant(overrides: Partial<DesktopCallStageParticipantTile> = {}): DesktopCallStageParticipantTile {
    return {
        id: "user-1",
        userId: "@alice:example.org",
        displayName: "Alice",
        initialLetter: "A",
        local: false,
        speaking: false,
        audioEnabled: true,
        videoEnabled: false,
        deafened: false,
        mirror: false,
        waitingForMedia: false,
        unencryptedWarning: false,
        encryptionStatus: "okay",
        handRaisedAt: null,
        reactionEmoji: null,
        video: null,
        hasVolumeControl: true,
        microphoneVolumePercent: 100,
        microphoneMuted: false,
        ...overrides,
    };
}

function makeScreenShare(overrides: Partial<DesktopCallStageScreenShareTile> = {}): DesktopCallStageScreenShareTile {
    return {
        id: "share-1",
        userId: "@bob:example.org",
        displayName: "Bob",
        initialLetter: "B",
        local: false,
        videoEnabled: true,
        audioEnabled: true,
        unencryptedWarning: false,
        encryptionStatus: "okay",
        video: null,
        hasStreamAudioVolumeControl: true,
        streamAudioVolumePercent: 80,
        streamAudioMuted: false,
        ...overrides,
    };
}

describe("DesktopCallStageView", () => {
    it("keeps audio in the main window and opens usable menus in the floating stage", async () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const target = iframe.contentWindow!;
        vi.spyOn(target, "close").mockImplementation(() => {});
        vi.stubGlobal("documentPictureInPicture", { requestWindow: vi.fn().mockResolvedValue(target) });
        const vm = new TestCallStageViewModel({ participants: [makeParticipant()] });
        const { unmount } = render(<DesktopCallStageView vm={vm} />);
        fireEvent.click(screen.getByRole("button", { name: "Pop out call" }));
        await waitFor(() =>
            expect(target.document.body.querySelector('[data-testid="aether-call-stage"]')).toBeTruthy(),
        );
        expect(screen.getByTestId("matrix-audio-renderer")).toBeInTheDocument();
        const floating = within(target.document.body);
        fireEvent.click(floating.getByRole("button", { name: "More microphone options" }));
        expect(floating.getByRole("dialog")).toBeVisible();
        fireEvent.keyDown(target.document, { key: "Escape" });
        expect(floating.queryByRole("dialog")).not.toBeInTheDocument();
        await act(() => {
            target.dispatchEvent(new Event("pagehide"));
        });
        expect(screen.getByTestId("aether-call-stage")).toBeInTheDocument();
        unmount();
        vi.unstubAllGlobals();
        iframe.remove();
    });

    it("keeps solo participant tiles at widescreen proportions in a short call window", () => {
        render(
            <div style={{ "width": "1000px", "height": "600px", "--cpd-space-2x": "8px" } as React.CSSProperties}>
                <DesktopCallStageView vm={new TestCallStageViewModel({ participants: [makeParticipant()] })} />
            </div>,
        );
        const { width, height } = screen.getByTestId("videoTile").getBoundingClientRect();
        expect(width / height).toBeCloseTo(16 / 9, 1);
    });

    it("uses the avatar's colour when the person has not chosen a profile theme", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 8;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#204060";
        context.fillRect(0, 0, 8, 8);
        const vm = new TestCallStageViewModel({ participants: [makeParticipant({ avatarUrl: canvas.toDataURL() })] });
        render(<DesktopCallStageView vm={vm} />);
        await waitFor(() =>
            expect(screen.getByTestId("videoTile").style.getPropertyValue("--call-tile-colour")).toBe("rgb(32 64 96)"),
        );
        expect(screen.getByRole("img", { name: "Alice" })).toBeVisible();
    });

    it("uses profile colours, decorations, effects and name styles on participant tiles", () => {
        const tile = makeParticipant({
            appearance: {
                theme: { primary: "#161339", accent: "#652c9a" },
                decoration: "neon-ring",
                effect: "embers",
                nameStyle: { font: "pixel", effect: "none", colour: "#dab3ff" },
            },
        });
        const { container } = render(
            <DesktopCallStageView vm={new TestCallStageViewModel({ participants: [tile] })} />,
        );
        expect(screen.getByTestId("videoTile").style.getPropertyValue("--call-tile-colour")).toBe("#161339");
        expect(container.querySelector('[data-decoration="neon-ring"]')).toBeInTheDocument();
        expect(container.querySelector('[data-effect="embers"]')).toBeInTheDocument();
        expect(screen.getByTestId("name_tag").querySelector('[data-font="pixel"]')).toHaveTextContent(tile.displayName);
    });

    it("explains unencrypted media in text without the unexplained corner glyph or duplicate header actions", () => {
        render(
            <DesktopCallStageView
                vm={new TestCallStageViewModel({ participants: [makeParticipant({ unencryptedWarning: true })] })}
            />,
        );
        expect(screen.getByRole("status")).toHaveTextContent("Media is not end-to-end encrypted");
        expect(screen.queryByTestId("encryption-badge-@alice:example.org")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Show Chat" })).not.toBeInTheDocument();
        expect(screen.queryByText("Voice Connected")).not.toBeInTheDocument();
    });

    it("changes only stream audio from the focused stream's visible volume slider", () => {
        const vm = new TestCallStageViewModel({
            participants: [makeParticipant()],
            screenShares: [makeScreenShare()],
            layoutMode: "spotlight",
        });
        render(<DesktopCallStageView vm={vm} />);
        const slider = screen.getByRole("slider", { name: /stream volume/i });
        fireEvent.change(slider, { target: { value: "37" } });
        expect(vm.setScreenShareAudioVolume).toHaveBeenCalledWith(makeScreenShare().id, 37);
        expect(vm.setParticipantMicrophoneVolume).not.toHaveBeenCalled();
    });

    it("keeps the voice lobby free of camera previews and in-call controls", async () => {
        const vm = new TestCallStageViewModel({ phase: "lobby", connected: false, localVideoEnabled: false });
        render(<DesktopCallStageView vm={vm} />);
        await expect.element(screen.getByTestId("lobby_joinCall")).toBeVisible();
        expect(screen.queryByText("Camera is off")).toBeNull();
        expect(screen.queryByTestId("incall_leave")).toBeNull();
        await fireEvent.click(screen.getByTestId("lobby_joinCall"));
        expect(vm.joinCall).toHaveBeenCalledOnce();
    });

    it("marks audio conversation calls for the compact avatar layout", async () => {
        const vm = new TestCallStageViewModel({ presentation: "conversation" });
        render(<DesktopCallStageView vm={vm} />);
        await expect
            .element(screen.getByTestId("aether-call-stage"))
            .toHaveAttribute("data-presentation", "conversation");
        await expect.element(screen.getByTestId("aether-call-stage")).toHaveAttribute("data-audio-only", "true");
    });

    it("renders lobby state with join button and triggers joinCall", () => {
        const vm = new TestCallStageViewModel({ phase: "lobby" });
        render(<DesktopCallStageView vm={vm} />);

        const joinBtn = screen.getByTestId("lobby_joinCall");
        expect(joinBtn).toBeInTheDocument();
        fireEvent.click(joinBtn);
        expect(vm.joinCall).toHaveBeenCalledTimes(1);
    });

    it("renders participant encryptionStatus warning and critical badges for missing or invalid keys", () => {
        const vm = new TestCallStageViewModel({
            participants: [
                makeParticipant({
                    id: "p-missing",
                    displayName: "MissingKeyUser",
                    encryptionStatus: "key_missing",
                }),
                makeParticipant({
                    id: "p-invalid",
                    displayName: "InvalidKeyUser",
                    encryptionStatus: "key_invalid",
                }),
            ],
        });

        const { container } = render(<DesktopCallStageView vm={vm} />);
        const tiles = screen.getAllByTestId("videoTile");
        expect(tiles).toHaveLength(2);
        expect(container.querySelectorAll('[data-tone="warning"]')).toHaveLength(1);
        expect(container.querySelectorAll('[data-tone="critical"]')).toHaveLength(1);
    });

    it("keeps video attachment mounted without detaching/reattaching across speaking state updates", () => {
        const videoHandle: DesktopCallStageVideoAttachment = {
            attach: vi.fn(),
            detach: vi.fn(),
        };
        const participant = makeParticipant({
            id: "p-1",
            videoEnabled: true,
            speaking: false,
            video: videoHandle,
        });
        const vm = new TestCallStageViewModel({
            participants: [participant],
        });

        render(<DesktopCallStageView vm={vm} />);
        expect(videoHandle.attach).toHaveBeenCalledTimes(1);
        expect(videoHandle.detach).not.toHaveBeenCalled();

        // Flip speaking state with the same stable video handle reference
        act(() => {
            vm.updateSnapshot({
                participants: [
                    {
                        ...participant,
                        speaking: true,
                        video: videoHandle,
                    },
                ],
            });
        });

        expect(videoHandle.attach).toHaveBeenCalledTimes(1);
        expect(videoHandle.detach).not.toHaveBeenCalled();
    });

    it("exposes independent participant microphone and screen share stream volume controls", () => {
        const vm = new TestCallStageViewModel({
            participants: [makeParticipant({ id: "p-bob", displayName: "Bob" })],
            screenShares: [makeScreenShare({ id: "s-bob", displayName: "Bob" })],
            openTileMenuId: "s-bob",
        });

        render(<DesktopCallStageView vm={vm} />);

        const slider = screen.getByRole("slider");
        fireEvent.change(slider, { target: { value: "45" } });
        expect(vm.setScreenShareAudioVolume).toHaveBeenCalledWith("s-bob", 45);
        expect(vm.setParticipantMicrophoneVolume).not.toHaveBeenCalled();
    });
    it("reports device failures with a dismiss action and preserves supported call actions", () => {
        const vm = new TestCallStageViewModel({ deviceError: "Microphone disconnected" });
        render(<DesktopCallStageView vm={vm} />);
        expect(screen.getByRole("alert").textContent).toContain("Could not change the device: Microphone disconnected");
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(vm.dismissDeviceError).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Reactions" }));
        fireEvent.click(screen.getByRole("button", { name: "Raise hand" }));
        fireEvent.click(screen.getByRole("button", { name: "Send reaction 👍" }));
        expect(vm.toggleRaisedHand).toHaveBeenCalledOnce();
        expect(vm.sendReaction).toHaveBeenCalledWith("👍");
    });

    it("disables system audio for the current Electron video-only capture", () => {
        const vm = new TestCallStageViewModel({ activeMenu: "screenshare", canShareSystemAudio: false });
        render(<DesktopCallStageView vm={vm} />);
        expect(screen.getByRole("checkbox")).toBeDisabled();
        expect(screen.getByRole("checkbox")).not.toBeChecked();
        expect(screen.getByText("This desktop capture shares video only.")).toBeVisible();
    });

    it("shows ended and permission-denied states with working recovery actions", () => {
        const vm = new TestCallStageViewModel({ phase: "ended", permissionError: "Permission denied" });
        render(<DesktopCallStageView vm={vm} />);
        expect(screen.getByRole("alert").textContent).toContain("Permission denied");
        fireEvent.click(screen.getByRole("button", { name: "Return to lobby" }));
        expect(vm.returnToLobby).toHaveBeenCalledOnce();
        act(() => vm.updateSnapshot({ phase: "lobby", needsDevicePermissions: true }));
        fireEvent.click(screen.getByRole("button", { name: "Allow microphone access" }));
        expect(vm.requestDevicePermissions).toHaveBeenCalledOnce();
    });

    it("detaches only its own video element when a track is replaced or the view unmounts", () => {
        const first = { attach: vi.fn(), detach: vi.fn() };
        const next = { attach: vi.fn(), detach: vi.fn() };
        const participant = makeParticipant({ videoEnabled: true, video: first });
        const vm = new TestCallStageViewModel({ participants: [participant] });
        const { unmount } = render(<DesktopCallStageView vm={vm} />);
        const element = first.attach.mock.calls[0][0];
        act(() => vm.updateSnapshot({ participants: [{ ...participant, video: next }] }));
        expect(first.detach).toHaveBeenCalledWith(element);
        expect(next.attach).toHaveBeenCalledWith(element);
        unmount();
        expect(next.detach).toHaveBeenCalledWith(element);
    });
    it("offers custom deployment limits below every standard quality preset", () => {
        const vm = new TestCallStageViewModel({
            activeMenu: "screenshare",
            screenShareQuality: {
                resolutionHeight: 540,
                frameRate: 12,
                maxBitrate: 750_000,
                includeSystemAudio: false,
            },
            screenSharePolicyLimits: { maxResolutionHeight: 540, maxFrameRate: 12, maxBitrate: 750_000 },
        });
        render(<DesktopCallStageView vm={vm} />);
        for (const name of ["540p", "12 FPS", "750 kbps"]) {
            expect(screen.getByRole("button", { name })).toBeEnabled();
            expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
        }
        expect(screen.getByRole("button", { name: "720p" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "15 FPS" })).toBeDisabled();
    });
    it("selects input, output and camera devices and restores focus when a menu closes", () => {
        const vm = new TestCallStageViewModel();
        render(<DesktopCallStageView vm={vm} />);
        const micTrigger = screen.getByRole("button", { name: "More microphone options" });
        fireEvent.click(micTrigger);
        expect(screen.getByRole("dialog", { name: "Input Device" })).toHaveFocus();
        fireEvent.click(screen.getByRole("menuitemradio", { name: /Studio Mic/ }));
        expect(vm.selectAudioInput).toHaveBeenCalledWith("mic-1");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        fireEvent.click(micTrigger);
        fireEvent.click(screen.getByRole("menuitemradio", { name: /Studio Monitors/ }));
        expect(vm.selectAudioOutput).toHaveBeenCalledWith("spk-1");
        fireEvent.click(screen.getByRole("button", { name: "More camera options" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name: /HD Webcam/ }));
        expect(vm.selectVideoInput).toHaveBeenCalledWith("cam-1");
        fireEvent.click(micTrigger);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(micTrigger).toHaveFocus();
        fireEvent.click(micTrigger);
        fireEvent.pointerDown(screen.getByTestId("aether-call-stage"));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps keyboard focus in a participant slider while playback values change", () => {
        const participant = makeParticipant();
        const vm = new TestCallStageViewModel({ participants: [participant] });
        render(<DesktopCallStageView vm={vm} />);
        const trigger = screen.getByRole("button", { name: "Audio options for Alice" });
        fireEvent.click(trigger);
        const slider = screen.getByRole("slider", { name: "Volume for Alice" });
        slider.focus();
        fireEvent.change(slider, { target: { value: "32" } });
        expect(vm.setParticipantMicrophoneVolume).toHaveBeenCalledWith("user-1", 32);
        act(() => vm.updateSnapshot({ participants: [{ ...participant, microphoneVolumePercent: 32 }] }));
        expect(slider).toHaveFocus();
        fireEvent.click(screen.getByRole("button", { name: "Mute Alice" }));
        expect(vm.toggleParticipantMicrophoneMuted).toHaveBeenCalledWith("user-1");
        fireEvent.keyDown(document, { key: "Escape" });
        expect(trigger).toHaveFocus();
    });

    it("applies quality choices and starts or stops sharing through the same menu", () => {
        const vm = new TestCallStageViewModel({ activeMenu: "screenshare" });
        render(<DesktopCallStageView vm={vm} />);
        fireEvent.click(screen.getByRole("button", { name: "720p" }));
        fireEvent.click(screen.getByRole("button", { name: "15 FPS" }));
        fireEvent.click(screen.getByRole("button", { name: "1.5 Mbps" }));
        fireEvent.click(screen.getByRole("checkbox"));
        expect(vm.updateScreenShareQuality.mock.calls).toEqual([
            [{ resolutionHeight: 720 }],
            [{ frameRate: 15 }],
            [{ maxBitrate: 1_500_000 }],
            [{ includeSystemAudio: false }],
        ]);
        fireEvent.click(screen.getByRole("button", { name: "Go Live" }));
        expect(vm.startScreenShareWithQuality).toHaveBeenCalledWith(
            expect.objectContaining({ resolutionHeight: 1080, frameRate: 30 }),
        );
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        act(() => vm.updateSnapshot({ activeMenu: "screenshare", sharingScreen: true }));
        fireEvent.click(screen.getByTestId("screenshare-menu-action-btn"));
        expect(vm.toggleScreenShare).toHaveBeenCalledOnce();
    });

    it("handles screen spotlight, stream mute and recovery banners without losing other participants", () => {
        const video = { attach: vi.fn(), detach: vi.fn() };
        const vm = new TestCallStageViewModel({
            participants: [makeParticipant({ waitingForMedia: true })],
            screenShares: [makeScreenShare({ video })],
            screenShareError: "Capture denied",
            reconnecting: true,
            keyRotationSuppressed: true,
            ringing: "ringing",
        });
        render(<DesktopCallStageView vm={vm} />);
        expect(video.attach).toHaveBeenCalledOnce();
        expect(screen.getByText("Connecting media...")).toBeVisible();
        expect(screen.getByText("Reconnecting...")).toBeVisible();
        expect(screen.getByText("Calling…")).toBeVisible();
        expect(screen.getByRole("alert").textContent).toContain("Capture denied");
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(vm.dismissScreenShareError).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Expand stream" }));
        expect(vm.setSpotlightTileId).toHaveBeenCalledWith("share-1");
        expect(screen.getAllByTestId("videoTile")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "Return to grid" }));
        expect(vm.setSpotlightTileId).toHaveBeenLastCalledWith(null);
        fireEvent.click(screen.getByRole("button", { name: "Mute Bob's stream audio" }));
        expect(vm.toggleScreenShareAudioMuted).toHaveBeenCalledWith("share-1");
        fireEvent.click(screen.getByRole("button", { name: "Focus View" }));
        expect(vm.setLayoutMode).toHaveBeenCalledWith("spotlight");
    });

    it("rings a conversation's callee as a faded, pulsing avatar until they join", () => {
        const me = makeParticipant({ id: "me", userId: "@me:example.org", displayName: "Me", local: true });
        const vm = new TestCallStageViewModel({
            presentation: "conversation",
            participants: [me],
            ringing: "ringing",
            callees: [{ userId: "@bob:example.org", displayName: "Bob", initialLetter: "B" }],
        });
        render(<DesktopCallStageView vm={vm} />);
        const callee = screen.getByRole("img", { name: "Calling Bob" });
        expect(callee).toBeVisible();
        expect(getComputedStyle(callee.querySelector("span")!.parentElement!).opacity).toBe("0.45");
        expect(screen.getByText("Calling…")).toBeVisible();

        act(() =>
            vm.updateSnapshot({
                ringing: null,
                callees: [],
                participants: [me, makeParticipant({ userId: "@bob:example.org", displayName: "Bob" })],
            }),
        );
        expect(screen.queryByRole("img", { name: "Calling Bob" })).toBeNull();
        expect(screen.getByRole("button", { name: "Participant Bob" })).toBeVisible();
        expect(screen.queryByText("Calling…")).toBeNull();
    });

    it("stops saying Calling once the ringing has timed out", () => {
        render(
            <DesktopCallStageView
                vm={new TestCallStageViewModel({ presentation: "conversation", ringing: "timeout" })}
            />,
        );
        expect(screen.queryByText("Calling…")).toBeNull();
    });

    it("shows mute and deafen on a conversation's avatars instead of names", () => {
        const vm = new TestCallStageViewModel({
            presentation: "conversation",
            participants: [makeParticipant({ audioEnabled: false, deafened: true })],
        });
        render(<DesktopCallStageView vm={vm} />);
        expect(screen.getByTestId("name_tag")).not.toBeVisible();
        expect(screen.getByLabelText("Microphone muted")).toBeVisible();
        expect(screen.getByLabelText("Deafened")).toBeVisible();
        // The name is still there for assistive technology.
        expect(screen.getByRole("button", { name: "Participant Alice" })).toBeInTheDocument();
    });

    it("exposes fatal recovery only for recoverable engine failures", () => {
        const fatalError = {
            code: "lost",
            title: "Connection lost",
            message: "Network unavailable",
            canReconnect: true,
        };
        const vm = new TestCallStageViewModel({ phase: "error", fatalError });
        render(<DesktopCallStageView vm={vm} />);
        expect(screen.getByRole("alert").textContent).toContain("Network unavailable");
        fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
        expect(vm.reconnect).toHaveBeenCalledOnce();
        act(() => vm.updateSnapshot({ fatalError: { ...fatalError, canReconnect: false } }));
        expect(screen.queryByRole("button", { name: "Try Again" })).not.toBeInTheDocument();
        fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[0]);
        expect(vm.leaveCall).toHaveBeenCalledOnce();
    });

    it("wires call navigation and local media controls while preview video remains engine owned", () => {
        const preview = { attach: vi.fn(), detach: vi.fn() };
        const vm = new TestCallStageViewModel({ phase: "lobby", localVideoEnabled: true, lobbyPreviewVideo: preview });
        const { unmount } = render(<DesktopCallStageView vm={vm} />);
        expect(preview.attach).toHaveBeenCalledWith(screen.getByTestId("lobby-preview-video"));
        act(() => vm.updateSnapshot({ phase: "in_call" }));
        fireEvent.click(screen.getByRole("button", { name: "Turn Off Camera" }));
        fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
        fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
        expect(vm.toggleLocalVideo).toHaveBeenCalledOnce();
        expect(vm.toggleLocalAudio).toHaveBeenCalledOnce();
        expect(vm.toggleFullscreen).toHaveBeenCalledWith(screen.getByTestId("aether-call-stage"));
        unmount();
        expect(preview.detach).toHaveBeenCalledOnce();
    });
});

it("opens the soundboard directly from the in-call toolbar", () => {
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
    const vm = new TestCallStageViewModel({ soundboard });
    render(<DesktopCallStageView vm={vm} />);
    fireEvent.click(screen.getByRole("button", { name: "Soundboard" }));
    expect(vm.setActiveMenu).toHaveBeenCalledWith("soundboard");
    expect(screen.getByRole("dialog", { name: "Soundboard" })).toBeVisible();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    const soundButton = screen.getByRole("button", { name: "Quack" });
    soundButton.focus();
    act(() => vm.updateSnapshot({ roomName: "Renamed room" }));
    expect(soundButton).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Quack" }));
    expect(soundboard.play).toHaveBeenCalledOnce();
});
