/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.hoisted(() => vi.fn());
vi.mock("@element-hq/element-call-component", () => ({ initializeElementCall: initialize, ElementCall: "call" }));
vi.mock("./ElementCallComponent.css", () => ({}));
vi.mock("../../../models/Call", () => ({ ElementCall: { getConfigOptions: vi.fn(() => ({ config: true })) } }));
vi.mock("../../../stores/CallStore", () => ({ CallStore: { instance: { getConfiguredRTCTransports: () => [] } } }));

describe("loadElementCallComponent", () => {
    beforeEach(() => {
        vi.resetModules();
        initialize.mockReset().mockResolvedValue(undefined);
    });

    it("shares one initialization between preparation and simultaneous joins", async () => {
        const { loadElementCallComponent } = await import("./ElementCallLoader");
        const first = loadElementCallComponent();
        expect(loadElementCallComponent()).toBe(first);
        await expect(first).resolves.toEqual({ default: "call" });
        expect(initialize).toHaveBeenCalledExactlyOnceWith({ config: true });
        expect(loadElementCallComponent()).toBe(first);
    });

    it("allows a later join to retry failed background initialization", async () => {
        initialize.mockRejectedValueOnce(new Error("offline"));
        const { loadElementCallComponent } = await import("./ElementCallLoader");
        await expect(loadElementCallComponent()).rejects.toThrow("offline");
        await expect(loadElementCallComponent()).resolves.toEqual({ default: "call" });
        expect(initialize).toHaveBeenCalledTimes(2);
    });
});
