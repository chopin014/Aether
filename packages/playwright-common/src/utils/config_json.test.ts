/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildConfigJson } from "./config_json.js";

describe("buildConfigJson", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("turns sliding sync on for every client when asked to, whatever labs flags a test sets", () => {
        vi.stubEnv("AETHER_E2E_SLIDING_SYNC", "1");

        const json = buildConfigJson("https://hs.example", {}, ["feature_something_else"]);

        expect(json.features).toMatchObject({
            feature_simplified_sliding_sync: true,
            feature_something_else: true,
        });
    });

    it("leaves sliding sync to the test otherwise", () => {
        vi.stubEnv("AETHER_E2E_SLIDING_SYNC", "");

        expect(buildConfigJson("https://hs.example").features?.feature_simplified_sliding_sync).toBeUndefined();
    });
});
