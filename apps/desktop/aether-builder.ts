/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import base from "./electron-builder.ts";
import desktopPackageJson from "./package.json" with { type: "json" };

const version = process.env.VERSION ?? desktopPackageJson.version;

/** Aether release identity. Internal workspace names stay stable for upstream merges. */
const config = {
    ...base,
    productName: "Aether",
    appId: "io.github.chopin014.aether",
    artifactName: "Aether-${version}-${os}-${arch}.${ext}",
    publish: [
        {
            provider: "github",
            owner: "chopin014",
            repo: "Aether",
            private: false,
            // Prerelease builds also check the stable feed so they can upgrade to the first stable release.
            channel: "latest",
        },
    ],
    generateUpdatesFilesForAllChannels: true,
    extraMetadata: {
        ...base.extraMetadata,
        name: "aether",
        productName: "Aether",
        description: "Aether desktop messenger for Matrix",
        version,
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
        target: ["AppImage"],
        executableName: "aether",
        icon: "aether/icon.png",
        maintainer: "Aether contributors <156453220+chopin014@users.noreply.github.com>",
    },
    deb: { ...base.deb, recommends: [] },
    win: {
        ...base.win,
        target: ["nsis"],
        icon: "aether/icon.ico",
        forceCodeSigning: false,
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
    },
};

export default config;
