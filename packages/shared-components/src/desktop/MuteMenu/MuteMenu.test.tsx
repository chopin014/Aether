/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { Menu } from "@vector-im/compound-web";
import { describe, expect, it, vi } from "vitest";

import { formatMutedUntil, MUTE_DURATIONS, MuteMenu } from "./MuteMenu";

function renderMenu(props: Partial<React.ComponentProps<typeof MuteMenu>> = {}): {
    onMute: ReturnType<typeof vi.fn>;
    onUnmute: ReturnType<typeof vi.fn>;
} {
    const onMute = vi.fn();
    const onUnmute = vi.fn();
    render(
        <Menu open onOpenChange={() => {}} title="Menu" showTitle={false} trigger={<button type="button">Open</button>}>
            <MuteMenu
                muteLabel="Mute channel"
                unmuteLabel="Unmute channel"
                isMuted={false}
                onMute={onMute}
                onUnmute={onUnmute}
                {...props}
            />
        </Menu>,
    );
    return { onMute, onUnmute };
}

describe("MuteMenu", () => {
    it("offers Discord's durations and muting until turned back on", async () => {
        const user = userEvent.setup();
        const { onMute } = renderMenu();
        await user.click(screen.getByRole("menuitem", { name: "Mute channel" }));
        const labels = ["For 15 minutes", "For 1 hour", "For 3 hours", "For 8 hours", "For 24 hours"];
        for (const label of labels) expect(await screen.findByRole("menuitem", { name: label })).toBeVisible();
        screen.getByRole("menuitem", { name: "Until I turn it back on" }).focus();
        await user.keyboard("{Enter}");
        expect(onMute).toHaveBeenCalledWith(null);
        expect(MUTE_DURATIONS).toEqual([900_000, 3_600_000, 10_800_000, 28_800_000, 86_400_000]);
    });

    it("turns a muted thing back on", async () => {
        const user = userEvent.setup();
        const { onUnmute } = renderMenu({ isMuted: true });
        await user.click(screen.getByRole("menuitem", { name: "Unmute channel" }));
        expect(onUnmute).toHaveBeenCalled();
    });

    it("writes the end of a mute as a time today, or with the day later on", () => {
        const now = new Date(2026, 10, 7, 10, 0).getTime();
        const today = formatMutedUntil(new Date(2026, 10, 7, 18, 30).getTime(), now);
        expect(today).toMatch(/18:30|6:30/);
        const tomorrow = formatMutedUntil(new Date(2026, 10, 8, 9, 15).getTime(), now);
        expect(tomorrow.length).toBeGreaterThan(today.length);
        expect(tomorrow).toMatch(/9:15/);
    });
});
