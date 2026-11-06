/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { CommandLine } from "electron";

/** Enable Chromium's supported Linux media accelerators before GPU initialization. */
export function configureMediaAcceleration(commandLine: CommandLine, platform: NodeJS.Platform): void {
    if (platform !== "linux") return;
    const features = new Set(commandLine.getSwitchValue("enable-features").split(",").filter(Boolean));
    features.add("AcceleratedVideoEncoder");
    features.add("AcceleratedVideoDecodeLinuxGL");
    commandLine.appendSwitch("enable-features", [...features].join(","));
}
