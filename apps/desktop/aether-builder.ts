/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import base from "./electron-builder.ts";

/** Aether release identity. Internal workspace names stay stable for upstream merges. */
const config = {
    ...base,
    appId: "io.github.chopin014.aether",
    artifactName: "Aether-${version}-${os}-${arch}.${ext}",
    publish: null,
    extraMetadata: {
        ...base.extraMetadata,
        name: "aether",
        productName: "Aether",
        description: "Aether desktop messenger for Matrix",
        version: process.env.VERSION ?? "0.1.0-dev.1",
        desktopName: "aether.desktop",
        electron_appId: "io.github.chopin014.aether",
        electron_protocol: "aether",
        homepage: "https://chopin014.github.io/Aether/",
        author: "Gabriel",
        repository: { type: "git", url: "https://github.com/chopin014/Aether" },
    },
    extraResources: [{ from: "aether", to: "build", filter: ["icon.*"] }, "webapp.asar"],
    protocols: { name: "Aether", schemes: ["aether"] },
    linux: {
        ...base.linux,
        target: ["AppImage", "deb", "tar.gz"],
        executableName: "aether",
        icon: "aether/icon.png",
        maintainer: "Aether contributors <156453220+chopin014@users.noreply.github.com>",
    },
    deb: { ...base.deb, recommends: [] },
    win: { ...base.win, target: ["nsis"], icon: "aether/icon.ico" },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true },
};

export default config;
