/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const nativeDirectory = path.join(desktopDirectory, "native", "share-audio", "windows");
const outputDirectory = path.join(nativeDirectory, "build", "Release");
const outputPath = path.join(outputDirectory, "aether-share-audio.exe");
const sourcePath = path.join(nativeDirectory, "aether-share-audio.cpp");
const responsePath = path.join(outputDirectory, "aether-share-audio.rsp");

/** Builds the standalone Windows process-loopback helper with the Visual C++ toolchain. */
async function buildWindowsShareAudioHelper(): Promise<void> {
    if (process.platform !== "win32") {
        throw new Error("The Windows share-audio helper must be built on Windows with Visual Studio Build Tools.");
    }

    const archArgument = process.argv.slice(2).find((argument) => argument.startsWith("--arch="));
    const targetArch = archArgument?.slice("--arch=".length) ?? "x64";
    if (targetArch !== "x64") {
        throw new Error(`The Windows share-audio helper currently supports x64 builds only (received ${targetArch}).`);
    }

    const configuredTargetArch = process.env.VSCMD_ARG_TGT_ARCH;
    if (configuredTargetArch && configuredTargetArch !== "x64") {
        throw new Error(`The active Visual Studio environment targets ${configuredTargetArch}; x64 is required.`);
    }

    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
        responsePath,
        [
            "/nologo",
            "/O2",
            "/EHsc",
            "/MT",
            "/std:c++17",
            "/DWIN32_LEAN_AND_MEAN",
            "/DNOMINMAX",
            "/DUNICODE",
            "/D_UNICODE",
            "/D_WIN32_WINNT=0x0A00",
            `/Fo"${path.join(outputDirectory, "aether-share-audio.obj")}"`,
            `/Fe"${outputPath}"`,
            `"${sourcePath}"`,
            "/link",
            "Mmdevapi.lib",
            "Ole32.lib",
            "User32.lib",
        ].join("\r\n"),
        "utf8",
    );

    const directCompiler = spawnSync("cl.exe", [`@${responsePath}`], { stdio: "inherit", windowsHide: true });
    const compilerIsMissing =
        directCompiler.error !== undefined && "code" in directCompiler.error && directCompiler.error.code === "ENOENT";
    if (!compilerIsMissing) {
        if (directCompiler.error) throw directCompiler.error;
        if (directCompiler.status !== 0) throw new Error(`cl.exe failed with exit code ${directCompiler.status}.`);
        return;
    }

    const vswherePath = path.join(
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe",
    );
    const vswhere = spawnSync(
        vswherePath,
        [
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ],
        { encoding: "utf8", windowsHide: true },
    );
    const installationPath = vswhere.stdout?.trim();
    if (vswhere.status !== 0 || !installationPath) {
        throw new Error("Visual Studio C++ Build Tools were not found. Install the x64 C++ toolchain and Windows SDK.");
    }

    const vcvarsPath = path.join(installationPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
    const commandLine = `call "${vcvarsPath}" x64 && cl.exe @"${responsePath}"`;
    const compiler = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
        stdio: "inherit",
        windowsHide: true,
        // cmd.exe needs its own quoting rather than the C runtime argument escaping used for ordinary executables.
        windowsVerbatimArguments: true,
    });
    if (compiler.error) throw compiler.error;
    if (compiler.status !== 0) throw new Error(`cl.exe failed with exit code ${compiler.status}.`);
}

await buildWindowsShareAudioHelper();
