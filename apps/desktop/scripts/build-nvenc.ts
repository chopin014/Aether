/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "tar";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const revision = "58fc3427a5b97701a6e70f266c1296fb7782f7c4";

if (process.platform === "linux") {
    const work = path.resolve(desktop, ".native-build");
    const source = path.resolve(work, "source");
    const target = path.resolve(work, "target");
    const output = path.resolve(desktop, "native-dist");
    mkdirSync(work, { recursive: true });
    const download = async (url: string, sha256: string, destination: string): Promise<void> => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Native source download failed: ${response.status}`);
        const archive = Buffer.from(await response.arrayBuffer());
        if (createHash("sha256").update(archive).digest("hex") !== sha256) {
            throw new Error("Native source checksum mismatch");
        }
        const archivePath = `${destination}.tar.gz`;
        writeFileSync(archivePath, archive);
        rmSync(destination, { recursive: true, force: true });
        mkdirSync(destination, { recursive: true });
        await extract({ file: archivePath, cwd: destination, strip: 1 });
    };
    await download(
        `https://codeload.github.com/nitkanikita21/nvenc-vaapi-driver/tar.gz/${revision}`,
        "3e2c6ceaf0a0a8c08eb0c743dde78ef6b4d4acab40803d5bf670e5c49b32a742",
        source,
    );
    // Pin the backend ABI instead of depending on each distribution's development header version.
    const headers = path.resolve(work, "libva");
    await download(
        "https://codeload.github.com/intel/libva/tar.gz/refs/tags/2.24.0",
        "6d4aff97decc0401875a25f8e1319e41e73f0d137f19fc330ba4506b18c65541",
        headers,
    );
    const version = readFileSync(path.resolve(headers, "va/va_version.h.in"), "utf8")
        .replaceAll("@VA_API_MAJOR_VERSION@", "1")
        .replaceAll("@VA_API_MINOR_VERSION@", "24")
        .replaceAll("@VA_API_MICRO_VERSION@", "0")
        .replaceAll("@VA_API_VERSION@", "1.24.0");
    writeFileSync(path.resolve(headers, "va/va_version.h"), version);
    execFileSync("patch", ["-p1", "--batch", "--forward", "-i", path.resolve(desktop, "native/nvenc.patch")], {
        cwd: source,
        stdio: "inherit",
    });
    copyFileSync(path.resolve(desktop, "native/nvenc-loader.rs"), path.resolve(source, "src/nvenc_loader.rs"));
    const entry = path.resolve(source, "src/lib.rs");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}\nmod nvenc_loader;\n`);
    const args = ["--locked", "--features", "nvidia-video-codec-sdk/ci-check", "--target-dir", target];
    const env = { ...process.env, BINDGEN_EXTRA_CLANG_ARGS: `-I${headers}` };
    execFileSync("cargo", ["test", "--lib", ...args], { cwd: source, env, stdio: "inherit" });
    execFileSync("cargo", ["build", "--release", ...args], { cwd: source, env, stdio: "inherit" });
    mkdirSync(output, { recursive: true });
    const routerTest = path.resolve(work, "vaapi-router-test");
    execFileSync(
        "cc",
        [
            "-Wall",
            "-Wextra",
            "-Werror",
            `-I${headers}`,
            path.resolve(desktop, "native/vaapi-router-test.c"),
            "-o",
            routerTest,
            "-ldl",
            "-lpthread",
        ],
        { stdio: "inherit" },
    );
    execFileSync(routerTest, [], { stdio: "inherit" });
    execFileSync(
        "cc",
        [
            "-shared",
            "-fPIC",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            `-I${headers}`,
            path.resolve(desktop, "native/vaapi-router.c"),
            "-o",
            path.resolve(output, "aether_nvenc_drv_video.so"),
            "-ldl",
            "-lpthread",
        ],
        { stdio: "inherit" },
    );
    copyFileSync(
        path.resolve(target, "release/libnvidia_nvenc_drv_video.so"),
        path.resolve(output, "nvidia_nvenc_drv_video.so"),
    );
    copyFileSync(path.resolve(source, "LICENSE-MIT"), path.resolve(output, "LICENSE-MIT"));
}
