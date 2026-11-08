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

    it("turns sliding sync off for every client when asked to, other than in a test that asks for it itself", () => {
        vi.stubEnv("AETHER_E2E_SLIDING_SYNC", "0");

        expect(buildConfigJson("https://hs.example", {}, ["feature_something_else"]).features).toMatchObject({
            feature_simplified_sliding_sync: false,
        });
        expect(
            buildConfigJson("https://hs.example", {}, ["feature_simplified_sliding_sync"]).features
                ?.feature_simplified_sliding_sync,
        ).toBe(true);
    });

    it("leaves sliding sync to the test otherwise", () => {
        vi.stubEnv("AETHER_E2E_SLIDING_SYNC", "");

        expect(buildConfigJson("https://hs.example").features?.feature_simplified_sliding_sync).toBeUndefined();
    });

    it("turns the new timeline on or off for every client when asked to, as it does sliding sync", () => {
        vi.stubEnv("AETHER_E2E_NEW_TIMELINE", "1");
        expect(buildConfigJson("https://hs.example", {}, ["feature_something_else"]).features).toMatchObject({
            feature_new_timeline: true,
            feature_something_else: true,
        });

        vi.stubEnv("AETHER_E2E_NEW_TIMELINE", "0");
        expect(buildConfigJson("https://hs.example").features?.feature_new_timeline).toBe(false);
        // A test that asks for the new timeline itself keeps it.
        expect(buildConfigJson("https://hs.example", {}, ["feature_new_timeline"]).features?.feature_new_timeline).toBe(
            true,
        );

        vi.stubEnv("AETHER_E2E_NEW_TIMELINE", "");
        expect(buildConfigJson("https://hs.example").features?.feature_new_timeline).toBeUndefined();
        // Each is its own switch.
        expect(buildConfigJson("https://hs.example").features?.feature_simplified_sliding_sync).toBeUndefined();
    });
});
