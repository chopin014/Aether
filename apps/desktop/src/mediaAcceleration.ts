/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { CommandLine } from "electron";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** VA-API driver name of the bundled NVENC bridge. */
const BRIDGE_DRIVER = "aether_nvenc";

/** Switch added to the relaunched instance so a launcher that drops the environment cannot cause a relaunch loop. */
const RELAUNCH_SWITCH = "aether-media-relaunched";

/**
 * Enable Chromium's hardware media encoders and decoders on Linux and Windows before GPU initialization.
 *
 * @returns Whether the app must relaunch before the GPU process can see the driver environment. Chromium forks the
 * GPU process from a helper that starts before this code runs, so environment changes made here only reach it in a
 * new instance.
 */
export function configureMediaAcceleration(
    commandLine: CommandLine,
    platform: NodeJS.Platform,
    resourcesPath?: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const features = new Set(commandLine.getSwitchValue("enable-features").split(",").filter(Boolean));
    if (platform === "win32") {
        // Chromium keeps these Media Foundation encoder paths behind flags on Windows. WebRTC negotiates H.264
        // Constrained Baseline, so without the first one hardware-capable H.264 shares are encoded in software.
        features.add("PlatformH264CbpEncoding");
        features.add("WebRtcAV1HWEncode");
        commandLine.appendSwitch("enable-features", [...features].join(","));
        return false;
    }
    if (platform !== "linux") return false;
    features.add("AcceleratedVideoEncoder");
    features.add("AcceleratedVideoDecodeLinuxGL");
    const driverDirectory = resourcesPath
        ? path.join(resourcesPath, "native", "nvenc")
        : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native-dist");
    const prepared = env.LIBVA_DRIVER_NAME === BRIDGE_DRIVER && env.LIBVA_DRIVERS_PATH === driverDirectory;
    // The bundled driver also routes decoding to NVIDIA's VA-API driver, so it can replace a `nvidia` override.
    const replaceable = !env.LIBVA_DRIVER_NAME || env.LIBVA_DRIVER_NAME === "nvidia";
    let relaunch = false;
    if ((prepared || replaceable) && existsSync(path.join(driverDirectory, `${BRIDGE_DRIVER}_drv_video.so`))) {
        // Chromium uses VA-API on Linux. NVIDIA's standard VA-API driver only exposes decoding.
        try {
            const renderNode = readdirSync("/sys/class/drm").find(
                (node) =>
                    /^renderD\d+$/.test(node) &&
                    readFileSync(`/sys/class/drm/${node}/device/vendor`, "utf8").trim() === "0x10de",
            );
            if (renderNode && (prepared || !commandLine.hasSwitch(RELAUNCH_SWITCH))) {
                if (!prepared) {
                    env.LIBVA_DRIVER_NAME = BRIDGE_DRIVER;
                    env.LIBVA_DRIVERS_PATH = driverDirectory;
                    env.__NV_PRIME_RENDER_OFFLOAD ??= "1";
                    env.__GLX_VENDOR_LIBRARY_NAME ??= "nvidia";
                    env.__VK_LAYER_NV_optimus ??= "NVIDIA_only";
                    relaunch = true;
                }
                commandLine.appendSwitch("render-node-override", `/dev/dri/${renderNode}`);
                if (!commandLine.getSwitchValue("use-gl")) commandLine.appendSwitch("use-gl", "angle");
                if (!commandLine.getSwitchValue("use-angle")) commandLine.appendSwitch("use-angle", "gl");
                features.add("VaapiOnNvidiaGPUs");
                features.add("VaapiIgnoreDriverChecks");
            }
        } catch {
            // Missing DRM nodes must not prevent startup or the standard VA-API/software fallback.
        }
    }
    commandLine.appendSwitch("enable-features", [...features].join(","));
    return relaunch;
}

/** Command that restarts this instance with the media driver environment, including from an AppImage. */
export function mediaRelaunchCommand(
    argv: string[],
    execPath: string,
    appImage?: string,
): { execPath: string; args: string[] } {
    const args = [...argv.slice(1), `--${RELAUNCH_SWITCH}`];
    // An AppImage's mounted executable disappears once this instance exits, so restart the image itself.
    return { execPath: appImage ?? execPath, args };
}
