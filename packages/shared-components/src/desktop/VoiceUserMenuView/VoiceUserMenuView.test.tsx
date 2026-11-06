/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";

import { MockViewModel } from "../../core/viewmodel";
import { VoiceUserMenuView, type VoiceUserMenuViewSnapshot } from "./VoiceUserMenuView";

const base: VoiceUserMenuViewSnapshot = {
    userId: "@bob:example.org",
    displayName: "Bob",
    isSelf: false,
    canMention: true,
    canMessage: true,
    canCall: true,
    volumePercent: 100,
    muted: false,
    soundboardMuted: false,
    videoDisabled: false,
    microphoneMuted: false,
    deafened: false,
    canVerify: true,
    isIgnored: false,
    inviteServers: [{ id: "!space:example.org", name: "Terra do boi gordo" }],
    roles: [
        { level: 100, label: "Admin", selected: false },
        { level: 50, label: "Moderator", selected: true },
        { level: 0, label: "Default", selected: false },
    ],
};

function makeVm(snapshot: Partial<VoiceUserMenuViewSnapshot> = {}) {
    return Object.assign(new MockViewModel<VoiceUserMenuViewSnapshot>({ ...base, ...snapshot }), {
        viewProfile: vi.fn(),
        mention: vi.fn(),
        message: vi.fn(),
        startCall: vi.fn(),
        setVolume: vi.fn(),
        toggleMuted: vi.fn(),
        toggleSoundboardMuted: vi.fn(),
        toggleVideoDisabled: vi.fn(),
        toggleMicrophoneMuted: vi.fn(),
        toggleDeafened: vi.fn(),
        editProfile: vi.fn(),
        verify: vi.fn(),
        inviteToServer: vi.fn(),
        copyUserId: vi.fn(),
        toggleIgnore: vi.fn(),
        setRole: vi.fn(),
    });
}

const names = (container: ParentNode = document): string[] =>
    [...container.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent ?? "");

describe("VoiceUserMenuView", () => {
    it("lists another person's entries in Discord's order", () => {
        render(<VoiceUserMenuView vm={makeVm()} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
        expect(names()).toEqual([
            "Profile",
            "Mention",
            "Message",
            "Start call",
            "Mute",
            "Mute soundboard",
            "Disable video",
            "Verify",
            "Invite to server",
            "Copy user ID",
            "Ignore",
            "Roles",
        ]);
        expect(screen.getByRole("menu", { name: "Options for Bob" })).toBeInTheDocument();
        expect(screen.getByRole("slider", { name: "Volume for Bob" })).toHaveAttribute("max", "200");
    });

    it("offers the user's own microphone and deafen on their own menu", () => {
        const vm = makeVm({ isSelf: true, microphoneMuted: true, inviteServers: [], roles: [] });
        render(<VoiceUserMenuView vm={vm} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
        expect(names()).toEqual(["Profile", "Mention", "Mute", "Deafen", "Edit profile", "Copy user ID"]);
        expect(screen.queryByRole("slider")).toBeNull();
        expect(screen.getByTestId("voice-user-menu-self-mute")).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByTestId("voice-user-menu-self-deafen"));
        expect(vm.toggleDeafened).toHaveBeenCalledOnce();
    });

    it("closes before running an entry that leaves the menu, and keeps toggles open", () => {
        const vm = makeVm();
        const onClose = vi.fn();
        render(<VoiceUserMenuView vm={vm} position={{ x: 10, y: 10 }} onClose={onClose} />);

        fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Mute" }));
        fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Mute soundboard" }));
        fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Disable video" }));
        expect(vm.toggleMuted).toHaveBeenCalledOnce();
        expect(vm.toggleSoundboardMuted).toHaveBeenCalledOnce();
        expect(vm.toggleVideoDisabled).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("menuitem", { name: "Message" }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(vm.message).toHaveBeenCalledOnce();
    });

    it("shows the volume up to 200%", () => {
        const vm = makeVm({ volumePercent: 150 });
        render(<VoiceUserMenuView vm={vm} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
        const slider = screen.getByRole("slider", { name: "Volume for Bob" });
        expect(slider).toHaveValue("150");
        expect(slider).toHaveAttribute("aria-valuetext", "150%");
        fireEvent.change(slider, { target: { value: "200" } });
        expect(vm.setVolume).toHaveBeenCalledWith(200);
    });

    it("shows a muted person at zero volume", () => {
        render(
            <VoiceUserMenuView
                vm={makeVm({ volumePercent: 150, muted: true })}
                position={{ x: 10, y: 10 }}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByRole("slider", { name: "Volume for Bob" })).toHaveValue("0");
        expect(screen.getByRole("menuitemcheckbox", { name: "Mute" })).toHaveAttribute("aria-checked", "true");
    });

    it("opens submenus for servers and roles", () => {
        const vm = makeVm();
        render(<VoiceUserMenuView vm={vm} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
        fireEvent.click(screen.getByTestId("voice-user-menu-invite"));
        fireEvent.click(screen.getByRole("menuitem", { name: "Terra do boi gordo" }));
        expect(vm.inviteToServer).toHaveBeenCalledWith("!space:example.org");

        fireEvent.click(screen.getByTestId("voice-user-menu-roles"));
        const roles = screen.getByRole("menu", { name: "Roles" });
        expect(names(roles)).toEqual(["Admin", "Moderator", "Default"]);
        expect(screen.getByRole("menuitemradio", { name: "Moderator" })).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Admin" }));
        expect(vm.setRole).toHaveBeenCalledWith(100);
    });

    it("moves between entries with the arrow keys and closes on Escape, returning focus", () => {
        const trigger = document.createElement("button");
        document.body.append(trigger);
        trigger.focus();
        const onClose = vi.fn();
        render(<VoiceUserMenuView vm={makeVm()} position={{ x: 10, y: 10 }} onClose={onClose} />);
        const menu = screen.getByRole("menu", { name: "Options for Bob" });
        fireEvent.keyDown(menu, { key: "ArrowDown" });
        expect(screen.getByRole("menuitem", { name: "Profile" })).toHaveFocus();
        fireEvent.keyDown(menu, { key: "ArrowDown" });
        expect(screen.getByRole("menuitem", { name: "Mention" })).toHaveFocus();
        fireEvent.keyDown(menu, { key: "End" });
        expect(screen.getByRole("menuitem", { name: "Roles" })).toHaveFocus();
        // Home and End move the volume slider itself rather than the focus.
        const slider = screen.getByRole("slider", { name: "Volume for Bob" });
        slider.focus();
        fireEvent.keyDown(slider, { key: "Home" });
        expect(slider).toHaveFocus();
        fireEvent.keyDown(menu, { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
        expect(trigger).toHaveFocus();
        trigger.remove();
    });

    it("closes on a click outside it, but not inside it", () => {
        const onClose = vi.fn();
        render(<VoiceUserMenuView vm={makeVm()} position={{ x: 10, y: 10 }} onClose={onClose} />);
        fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Profile" }));
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.pointerDown(document.body);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("hides entries the person cannot use", () => {
        const vm = makeVm({ canCall: false, canVerify: false, inviteServers: [], roles: [], isIgnored: true });
        render(<VoiceUserMenuView vm={vm} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
        expect(names()).not.toContain("Start call");
        expect(names()).not.toContain("Verify");
        expect(names()).not.toContain("Invite to server");
        expect(names()).not.toContain("Roles");
        expect(names()).toContain("Stop ignoring");
    });
});
