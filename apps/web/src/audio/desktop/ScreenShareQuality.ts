/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { DesktopCallStagePolicyLimits, DesktopCallStageQualityState } from "@element-hq/web-shared-components";

import SdkConfig from "../../SdkConfig";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Deployment limits used by the embedded call engine, including its default screen-share limits. */
export function getScreenSharePolicyLimits(): DesktopCallStagePolicyLimits {
    const policy = SdkConfig.get("element_call")?.media_quality?.screen_share;
    return {
        maxResolutionHeight: positive(policy?.max_resolution) ? policy.max_resolution : 1080,
        maxFrameRate: positive(policy?.max_framerate) ? policy.max_framerate : 30,
        maxBitrate: positive(policy?.max_bitrate) ? policy.max_bitrate : 5_000_000,
    };
}

/** Validate a requested preference and apply deployment limits before it reaches capture or the call engine. */
export function resolveScreenShareQuality(
    raw: Partial<DesktopCallStageQualityState>,
    limits: DesktopCallStagePolicyLimits = getScreenSharePolicyLimits(),
): DesktopCallStageQualityState {
    const maxHeight = positive(limits.maxResolutionHeight) ? limits.maxResolutionHeight : null;
    const maxFrameRate = positive(limits.maxFrameRate) ? limits.maxFrameRate : 60;
    const maxBitrate = positive(limits.maxBitrate) ? limits.maxBitrate : null;
    const height = raw.resolutionHeight === null || positive(raw.resolutionHeight) ? raw.resolutionHeight : 1080;
    const fps = positive(raw.frameRate) ? raw.frameRate : 30;
    const bitrate = positive(raw.maxBitrate) ? raw.maxBitrate : null;
    return {
        resolutionHeight: maxHeight !== null ? Math.min(height ?? maxHeight, maxHeight) : height,
        frameRate: Math.min(fps, maxFrameRate, 60),
        maxBitrate: bitrate !== null && maxBitrate !== null ? Math.min(bitrate, maxBitrate) : bitrate,
        includeSystemAudio: typeof raw.includeSystemAudio === "boolean" ? raw.includeSystemAudio : false,
    };
}
