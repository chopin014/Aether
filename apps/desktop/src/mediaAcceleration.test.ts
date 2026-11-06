/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { CommandLine } from "electron";
import { describe, expect, it, vi } from "vitest";

import { configureMediaAcceleration } from "./mediaAcceleration.js";

describe("media acceleration", () => {
    it("enables VA-API media paths and retains existing Chromium features", () => {
        const commandLine = {
            getSwitchValue: vi.fn(() => "ExistingFeature,AcceleratedVideoEncoder"),
            appendSwitch: vi.fn(),
        };
        configureMediaAcceleration(commandLine as unknown as CommandLine, "linux");
        expect(commandLine.appendSwitch).toHaveBeenCalledWith(
            "enable-features",
            "ExistingFeature,AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL",
        );
    });

    it.each(["win32", "darwin"] as const)("retains native platform defaults on %s", (platform) => {
        const commandLine = { getSwitchValue: vi.fn(), appendSwitch: vi.fn() };
        configureMediaAcceleration(commandLine as unknown as CommandLine, platform);
        expect(commandLine.appendSwitch).not.toHaveBeenCalled();
    });
});
