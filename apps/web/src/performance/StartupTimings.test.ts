/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { logger } from "matrix-js-sdk/src/logger";

import { getStartupTimings, markStartup } from "./StartupTimings";

describe("StartupTimings", () => {
    it("records each step once and logs a summary when the chats are shown", () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        const mark = vi.spyOn(performance, "mark");

        markStartup("boot");
        markStartup("boot");
        markStartup("store_ready");
        expect(mark.mock.calls.filter(([name]) => name === "aether:startup:boot")).toHaveLength(1);
        expect(info).not.toHaveBeenCalled();

        markStartup("chats_shown");
        expect(Object.keys(getStartupTimings())).toEqual(
            expect.arrayContaining(["boot", "store_ready", "chats_shown"]),
        );
        expect(info).toHaveBeenCalledWith(expect.stringMatching(/^Startup timings: boot=\d+ms .*chats_shown=\d+ms/));
    });
});
