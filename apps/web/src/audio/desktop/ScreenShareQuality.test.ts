/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it } from "vitest";

import SdkConfig from "../../SdkConfig";
import { getScreenSharePolicyLimits, resolveScreenShareQuality } from "./ScreenShareQuality";

describe("screen-share quality policy", () => {
    afterEach(() => SdkConfig.reset());

    it("bounds source resolution and all numeric controls by deployment limits", () => {
        SdkConfig.put({
            element_call: {
                media_quality: {
                    screen_share: {
                        max_resolution: 540,
                        max_framerate: 12,
                        max_bitrate: 750_000,
                    },
                },
            },
        });
        expect(
            resolveScreenShareQuality({
                resolutionHeight: null,
                frameRate: 60,
                maxBitrate: 6_000_000,
                includeSystemAudio: true,
            }),
        ).toEqual({ resolutionHeight: 540, frameRate: 12, maxBitrate: 750_000, includeSystemAudio: true });
    });

    it("replaces invalid preferences and deployment values with finite defaults", () => {
        SdkConfig.put({
            element_call: {
                media_quality: {
                    screen_share: {
                        max_resolution: Number.NaN,
                        max_framerate: -10,
                        max_bitrate: Number.POSITIVE_INFINITY,
                    },
                },
            },
        });
        expect(getScreenSharePolicyLimits()).toEqual({
            maxResolutionHeight: 1080,
            maxFrameRate: 30,
            maxBitrate: 5_000_000,
        });
        expect(resolveScreenShareQuality({ resolutionHeight: -1, frameRate: Number.NaN, maxBitrate: -1 })).toEqual({
            resolutionHeight: 1080,
            frameRate: 30,
            maxBitrate: null,
            includeSystemAudio: false,
        });
    });
});
