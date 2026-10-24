/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmVoiceChannelSwitch } from "./confirmVoiceChannelSwitch";
import SettingsStore from "../../../settings/SettingsStore";
import Modal from "../../../Modal";

function settings(values: Record<string, boolean>): void {
    vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => values[name] as never);
}
function answer(confirmed: boolean): ReturnType<typeof vi.spyOn> {
    return vi
        .spyOn(Modal, "createDialog")
        .mockReturnValue({ finished: Promise.resolve([confirmed]) } as unknown as ReturnType<
            typeof Modal.createDialog
        >);
}

describe("confirmVoiceChannelSwitch", () => {
    afterEach(() => vi.restoreAllMocks());

    it("lets the switch through without asking when the warning is off", async () => {
        settings({ feature_desktop_shell: true, desktopVoiceSwitchWarning: false });
        const dialog = answer(false);
        await expect(confirmVoiceChannelSwitch()).resolves.toBe(true);
        expect(dialog).not.toHaveBeenCalled();
    });

    it("never asks outside the desktop shell", async () => {
        settings({ feature_desktop_shell: false, desktopVoiceSwitchWarning: true });
        const dialog = answer(false);
        await expect(confirmVoiceChannelSwitch()).resolves.toBe(true);
        expect(dialog).not.toHaveBeenCalled();
    });

    it("follows the answer when the warning is on", async () => {
        settings({ feature_desktop_shell: true, desktopVoiceSwitchWarning: true });
        answer(true);
        await expect(confirmVoiceChannelSwitch()).resolves.toBe(true);
        vi.restoreAllMocks();
        settings({ feature_desktop_shell: true, desktopVoiceSwitchWarning: true });
        answer(false);
        await expect(confirmVoiceChannelSwitch()).resolves.toBe(false);
    });
});
