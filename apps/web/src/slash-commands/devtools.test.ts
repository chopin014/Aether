/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from "vitest";

import { setUpCommandTest } from "./__mocks__";
import SettingsStore from "../settings/SettingsStore";

describe("/devtools", () => {
    const roomId = "!room:example.com";

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const mockDeveloperMode = (enabled: boolean): void => {
        const original = SettingsStore.getValue;
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...rest) =>
            name === "developerMode" ? enabled : original(name, ...rest),
        );
    };

    it("is not offered while developer mode is off", () => {
        mockDeveloperMode(false);
        // A disabled command cannot be looked up at all.
        const { command } = setUpCommandTest(roomId, "/devtools");
        expect(command).toBeUndefined();
    });

    it("is offered once developer mode is on", () => {
        mockDeveloperMode(true);
        const { client, command } = setUpCommandTest(roomId, "/devtools");
        expect(command.isEnabled(client, roomId)).toBe(true);
    });
});
