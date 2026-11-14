/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { type Config } from "../index.js";
import { buildConfigJson } from "./config_json.js";

describe("buildConfigJson", () => {
    /** Set every switch, so the environment the tests run in does not leak in. */
    const switches = (slidingSync: string, newTimeline: string, retainedTimeline = ""): void => {
        vi.stubEnv("AETHER_E2E_SLIDING_SYNC", slidingSync);
        vi.stubEnv("AETHER_E2E_NEW_TIMELINE", newTimeline);
        vi.stubEnv("AETHER_E2E_RETAINED_TIMELINE", retainedTimeline);
    };
    const features = (additional: Partial<Config> = {}, labsFlags: string[] = []) =>
        buildConfigJson("https://hs.example", additional, labsFlags).features;

    afterEach(() => vi.unstubAllEnvs());

    it.each([
        ["sliding sync", "feature_simplified_sliding_sync", (mode: string) => switches(mode, "")],
        ["the new timeline", "feature_new_timeline", (mode: string) => switches("", mode)],
        ["the room timeline host", "feature_retained_room_timeline", (mode: string) => switches("", "", mode)],
    ])("turns %s on or off for every client when asked to", (_name, feature, set) => {
        set("1");
        expect(features({}, ["feature_something_else"])).toMatchObject({
            [feature]: true,
            feature_something_else: true,
        });
        set("0");
        expect(features()?.[feature]).toBe(false);
        set("");
        expect(features()?.[feature]).toBeUndefined();
    });

    it.each([
        ["sliding sync", "feature_simplified_sliding_sync", (mode: string) => switches(mode, "")],
        ["the new timeline", "feature_new_timeline", (mode: string) => switches("", mode)],
        ["the room timeline host", "feature_retained_room_timeline", (mode: string) => switches("", "", mode)],
    ])("leaves %s as a test sets it itself, through its lab flags or its own config", (_name, feature, set) => {
        set("0");
        expect(features({}, [feature])?.[feature]).toBe(true);
        expect(features({ features: { [feature]: true } })?.[feature]).toBe(true);
        // A test that runs both ways, such as the scroll anchoring one, keeps its old-timeline variant with "1".
        set("1");
        expect(features({ features: { [feature]: false } })?.[feature]).toBe(false);
    });

    it("keeps the switches apart", () => {
        switches("1", "0", "1");
        expect(features()).toMatchObject({
            feature_simplified_sliding_sync: true,
            feature_new_timeline: false,
            feature_retained_room_timeline: true,
        });
        switches("0", "1", "0");
        expect(features()).toMatchObject({
            feature_simplified_sliding_sync: false,
            feature_new_timeline: true,
            feature_retained_room_timeline: false,
        });
    });
});
