/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen } from "test-utils-rtl";

import { confirmVoiceChannelSwitch } from "./confirmVoiceChannelSwitch";
import SettingsStore from "../../../settings/SettingsStore";
import Modal from "../../../Modal";
import QuestionDialog from "../dialogs/QuestionDialog";
import { SettingLevel } from "../../../settings/SettingLevel";

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

    it.each([true, false])("saves Don't ask again only when the switch is confirmed: %s", async (confirmed) => {
        settings({ feature_desktop_shell: true, desktopVoiceSwitchWarning: true });
        const saved = vi.spyOn(SettingsStore, "setValue").mockResolvedValue();
        const finished = Promise.withResolvers<[boolean]>();
        const dialog = vi.spyOn(Modal, "createDialog").mockReturnValue({
            finished: finished.promise,
        } as unknown as ReturnType<typeof Modal.createDialog>);
        const switching = confirmVoiceChannelSwitch("Lounge");
        const props = dialog.mock.calls[0][1];
        render(createElement(QuestionDialog, { ...props, onFinished: (ok) => finished.resolve([!!ok]) }));
        expect(screen.getByText("Lounge", { selector: "strong" })).toBeVisible();
        fireEvent.click(screen.getByRole("checkbox", { name: "Don’t ask again" }));
        fireEvent.click(screen.getByRole("button", { name: confirmed ? "Switch channel" : "Cancel" }));
        await expect(switching).resolves.toBe(confirmed);
        if (confirmed) {
            expect(saved).toHaveBeenCalledWith("desktopVoiceSwitchWarning", null, SettingLevel.DEVICE, false);
        } else {
            expect(saved).not.toHaveBeenCalled();
        }
    });
});
