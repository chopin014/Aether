/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import config from "../aether-builder.ts";

describe("Aether distribution identity", () => {
    it("isolates installation, profiles and callback URLs from Element", () => {
        expect(config.appId).toBe("io.github.chopin014.aether");
        expect(config.extraMetadata).toMatchObject({
            name: "aether",
            productName: "Aether",
            desktopName: "aether.desktop",
            electron_protocol: "aether",
        });
        expect(config.protocols.schemes).toEqual(["aether"]);
        expect(config.linux.executableName).toBe("aether");
        expect(config.deb.recommends).toEqual([]);
    });
    it("prepares Linux and Windows artifacts without publishing", () => {
        expect(config.publish).toBeNull();
        expect(config.linux.target).toEqual(["AppImage", "deb", "tar.gz"]);
        expect(config.linux.maintainer).toBe("Aether contributors <156453220+chopin014@users.noreply.github.com>");
        expect(config.win.target).toEqual(["nsis"]);
        expect(config.extraResources).toContainEqual({ from: "aether", to: "build", filter: ["icon.*"] });
    });
    it("ships the Matrix desktop shell and Element Call without an upstream update feed", () => {
        const renderer = JSON.parse(readFileSync("config.desktop.json", "utf8"));
        expect(renderer.brand).toBe("Aether");
        expect(renderer.features.feature_desktop_shell).toBe(true);
        expect(renderer.element_call.use_exclusively).toBe(true);
        expect(renderer.update_base_url).toBeUndefined();
        expect(renderer.posthog).toBeUndefined();
        expect(renderer.bug_report_endpoint_url).toBeUndefined();
    });
});
