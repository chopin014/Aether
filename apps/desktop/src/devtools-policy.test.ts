/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { devToolsAllowed } from "./devtools-policy.js";

describe("devToolsAllowed", () => {
    it("blocks the developer tools in release builds", () => {
        expect(devToolsAllowed({ devtools: false }, true)).toBe(false);
    });

    it("allows them in a release build started with --devtools", () => {
        expect(devToolsAllowed({ devtools: true }, true)).toBe(true);
    });

    it("allows them in development builds", () => {
        expect(devToolsAllowed({ devtools: false }, false)).toBe(true);
    });
});
