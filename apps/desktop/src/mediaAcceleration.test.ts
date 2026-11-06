/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { CommandLine } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { configureMediaAcceleration, mediaRelaunchCommand } from "./mediaAcceleration.js";

vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn() }));

describe("media acceleration", () => {
    beforeEach(() => {
        vi.mocked(existsSync).mockReturnValue(false);
        vi.mocked(readdirSync).mockReset();
        vi.mocked(readFileSync).mockReset();
    });

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
        expect(configureMediaAcceleration(commandLine as unknown as CommandLine, platform)).toBe(false);
        expect(commandLine.appendSwitch).not.toHaveBeenCalled();
    });

    it("selects the bundled NVENC bridge on NVIDIA without changing the parent environment", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockReturnValue(["card0", "renderD129"] as never);
        vi.mocked(readFileSync).mockReturnValue("0x10de\n");
        const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn(), hasSwitch: vi.fn(() => false) };
        const env: NodeJS.ProcessEnv = {};
        expect(configureMediaAcceleration(commandLine as unknown as CommandLine, "linux", "/app/resources", env)).toBe(
            true,
        );
        expect(env).toEqual({
            LIBVA_DRIVER_NAME: "aether_nvenc",
            LIBVA_DRIVERS_PATH: "/app/resources/native/nvenc",
            __NV_PRIME_RENDER_OFFLOAD: "1",
            __GLX_VENDOR_LIBRARY_NAME: "nvidia",
            __VK_LAYER_NV_optimus: "NVIDIA_only",
        });
        expect(existsSync).toHaveBeenCalledWith("/app/resources/native/nvenc/aether_nvenc_drv_video.so");
        expect(commandLine.appendSwitch).toHaveBeenCalledWith("render-node-override", "/dev/dri/renderD129");
        expect(commandLine.appendSwitch).toHaveBeenCalledWith(
            "enable-features",
            "AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL,VaapiOnNvidiaGPUs,VaapiIgnoreDriverChecks",
        );
    });

    it("replaces NVIDIA's decode-only VA-API driver override with the bundled bridge", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockReturnValue(["renderD128"] as never);
        vi.mocked(readFileSync).mockReturnValue("0x10de");
        const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn(), hasSwitch: vi.fn(() => false) };
        const env: NodeJS.ProcessEnv = { LIBVA_DRIVER_NAME: "nvidia" };
        expect(configureMediaAcceleration(commandLine as unknown as CommandLine, "linux", "/resources", env)).toBe(
            true,
        );
        expect(env).toMatchObject({ LIBVA_DRIVER_NAME: "aether_nvenc", LIBVA_DRIVERS_PATH: "/resources/native/nvenc" });
    });

    it("applies the NVENC switches without relaunching once the environment is prepared", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockReturnValue(["renderD129"] as never);
        vi.mocked(readFileSync).mockReturnValue("0x10de");
        const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn(), hasSwitch: vi.fn(() => true) };
        const env: NodeJS.ProcessEnv = {
            LIBVA_DRIVER_NAME: "aether_nvenc",
            LIBVA_DRIVERS_PATH: "/resources/native/nvenc",
        };
        expect(configureMediaAcceleration(commandLine as unknown as CommandLine, "linux", "/resources", env)).toBe(
            false,
        );
        expect(env).toEqual({ LIBVA_DRIVER_NAME: "aether_nvenc", LIBVA_DRIVERS_PATH: "/resources/native/nvenc" });
        expect(commandLine.appendSwitch).toHaveBeenCalledWith("render-node-override", "/dev/dri/renderD129");
        expect(commandLine.appendSwitch).toHaveBeenCalledWith(
            "enable-features",
            "AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxGL,VaapiOnNvidiaGPUs,VaapiIgnoreDriverChecks",
        );
    });

    it("does not relaunch again when a relaunched instance lost the driver environment", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockReturnValue(["renderD129"] as never);
        vi.mocked(readFileSync).mockReturnValue("0x10de");
        const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn(), hasSwitch: vi.fn(() => true) };
        const env: NodeJS.ProcessEnv = {};
        expect(configureMediaAcceleration(commandLine as unknown as CommandLine, "linux", "/resources", env)).toBe(
            false,
        );
        expect(commandLine.hasSwitch).toHaveBeenCalledWith("aether-media-relaunched");
        expect(env).toEqual({});
        expect(commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    });

    it("relaunches through the AppImage when one is running", () => {
        expect(
            mediaRelaunchCommand(["/tmp/.mount/aether", "--hidden"], "/tmp/.mount/aether", "/home/u/A.AppImage"),
        ).toEqual({
            execPath: "/home/u/A.AppImage",
            args: ["--hidden", "--aether-media-relaunched"],
        });
        expect(mediaRelaunchCommand(["/opt/Aether/aether", "--hidden"], "/opt/Aether/aether")).toEqual({
            execPath: "/opt/Aether/aether",
            args: ["--hidden", "--aether-media-relaunched"],
        });
    });

    it.each(["0x1002", "0x8086"])("retains the system VA-API driver for vendor %s", (vendor) => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockReturnValue(["renderD128"] as never);
        vi.mocked(readFileSync).mockReturnValue(vendor);
        const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn() };
        const env: NodeJS.ProcessEnv = {};
        expect(configureMediaAcceleration(commandLine as unknown as CommandLine, "linux", "/resources", env)).toBe(
            false,
        );
        expect(env).toEqual({});
        expect(commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    });

    it("honors an explicit VA-API driver override", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn() };
        const env = { LIBVA_DRIVER_NAME: "custom" };
        configureMediaAcceleration(commandLine as unknown as CommandLine, "linux", "/resources", env);
        expect(env).toEqual({ LIBVA_DRIVER_NAME: "custom" });
        expect(readdirSync).not.toHaveBeenCalled();
    });

    it("starts normally when DRM discovery is unavailable", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockImplementation(() => {
            throw new Error("ENOENT");
        });
        const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn() };
        const env: NodeJS.ProcessEnv = {};
        expect(() =>
            configureMediaAcceleration(commandLine as unknown as CommandLine, "linux", "/resources", env),
        ).not.toThrow();
        expect(env).toEqual({});
    });
});
