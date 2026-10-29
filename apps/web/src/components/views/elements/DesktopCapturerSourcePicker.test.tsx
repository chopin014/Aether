/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";

import { DesktopCapturerSourcePicker } from "./DesktopCapturerSourcePicker";
import PlatformPeg from "../../../PlatformPeg";
import type BasePlatform from "../../../BasePlatform";
import { DesktopVoicePipeline } from "../../../audio/desktop/DesktopVoicePipeline";
import SettingsStore from "../../../settings/SettingsStore";
import SdkConfig from "../../../SdkConfig";

const SOURCES = [
    {
        id: "screen1",
        name: "Screen 1",
        thumbnailURL: "data:image/png;base64,",
    },
    {
        id: "window1",
        name: "Window 1",
        thumbnailURL: "data:image/png;base64,",
    },
];

describe("DesktopCapturerSourcePicker", () => {
    beforeEach(() => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        const plaf = {
            getDesktopCapturerSources: vi.fn().mockResolvedValue(SOURCES),
            supportsSetting: vi.fn().mockReturnValue(false),
        };
        vi.spyOn(PlatformPeg, "get").mockReturnValue(plaf as unknown as BasePlatform);
        DesktopVoicePipeline.instance.setScreenShareQuality({
            resolutionHeight: 1080,
            frameRate: 30,
            maxBitrate: null,
            includeSystemAudio: true,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        SdkConfig.reset();
    });

    it("should render the component", () => {
        render(<DesktopCapturerSourcePicker onFinished={() => {}} />);
        expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    });

    it("should disable share button until a source is selected", () => {
        render(<DesktopCapturerSourcePicker onFinished={() => {}} />);
        expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
    });

    it("should contain a screen source in the default tab", async () => {
        render(<DesktopCapturerSourcePicker onFinished={() => {}} />);

        const screen1Button = await screen.findByRole("button", { name: "Screen 1" });

        expect(screen1Button).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Window 1" })).not.toBeInTheDocument();
    });

    it("should contain a window source in the window tab", async () => {
        render(<DesktopCapturerSourcePicker onFinished={() => {}} />);

        await userEvent.click(screen.getByRole("tab", { name: "Application window" }));

        const window1Button = await screen.findByRole("button", { name: "Window 1" });

        expect(window1Button).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Screen 1" })).not.toBeInTheDocument();
    });

    it("should call onFinished with no arguments if cancelled", async () => {
        const onFinished = vi.fn();
        render(<DesktopCapturerSourcePicker onFinished={onFinished} />);

        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onFinished).toHaveBeenCalledWith();
    });

    it("should call onFinished with the selected source when share clicked", async () => {
        const onFinished = vi.fn();
        render(<DesktopCapturerSourcePicker onFinished={onFinished} />);

        const screen1Button = await screen.findByRole("button", { name: "Screen 1" });

        await userEvent.click(screen1Button);
        await userEvent.click(screen.getByRole("button", { name: "Share" }));
        expect(onFinished).toHaveBeenCalledWith(SOURCES[0]);
    });

    it("confirms the chosen source and quality only after both desktop picker steps", async () => {
        vi.mocked(SettingsStore.getValue).mockImplementation((key) => key === "feature_desktop_shell");
        SdkConfig.put({
            element_call: {
                media_quality: {
                    screen_share: {
                        max_resolution: 1440,
                        max_framerate: 60,
                        max_bitrate: 6_000_000,
                    },
                },
            },
        });
        const onFinished = vi.fn();
        render(<DesktopCapturerSourcePicker onFinished={onFinished} />);

        await userEvent.click(await screen.findByRole("button", { name: "Window 1" }));
        await userEvent.click(screen.getByRole("button", { name: "Next" }));

        await userEvent.click(screen.getByRole("button", { name: "1440p" }));
        await userEvent.click(screen.getByRole("button", { name: "60 FPS" }));
        await userEvent.click(screen.getByRole("button", { name: "6 Mbps" }));
        expect(onFinished).not.toHaveBeenCalled();
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Share" }));

        expect(onFinished).toHaveBeenCalledWith(SOURCES[1]);
        expect(DesktopVoicePipeline.instance.getScreenShareQuality()).toEqual({
            resolutionHeight: 1440,
            frameRate: 60,
            maxBitrate: 6_000_000,
            includeSystemAudio: false,
        });
    });
});
