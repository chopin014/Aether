/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.hoisted(() => vi.fn());
const setServiceUrl = vi.hoisted(() => vi.fn());
const setOpenIdTokens = vi.hoisted(() => vi.fn());
vi.mock("@element-hq/element-call-component", () => ({
    initializeElementCall: initialize,
    setElementCallServiceUrl: setServiceUrl,
    setElementCallOpenIdTokens: setOpenIdTokens,
    ElementCall: "call",
}));
vi.mock("./ElementCallComponent.css", () => ({}));
vi.mock("./ElementCallService", () => ({ callServiceUrlFor: vi.fn() }));
vi.mock("../../../models/Call", () => ({ ElementCall: { getConfigOptions: vi.fn(() => ({ config: true })) } }));

describe("loadElementCallComponent", () => {
    beforeEach(() => {
        vi.resetModules();
        initialize.mockReset().mockResolvedValue(undefined);
        setServiceUrl.mockReset();
        setOpenIdTokens.mockReset();
    });

    it("shares one initialization between preparation and simultaneous joins", async () => {
        const { loadElementCallComponent } = await import("./ElementCallLoader");
        const first = loadElementCallComponent();
        expect(loadElementCallComponent()).toBe(first);
        await expect(first).resolves.toEqual({ default: "call" });
        expect(initialize).toHaveBeenCalledExactlyOnceWith({ config: true });
        expect(loadElementCallComponent()).toBe(first);
    });

    it("asks the joining account for its call service rather than fixing the first account's", async () => {
        const { loadElementCallComponent } = await import("./ElementCallLoader");
        const { ElementCall } = await import("../../../models/Call");
        const { callServiceUrlFor } = await import("./ElementCallService");
        await loadElementCallComponent();
        expect(setServiceUrl).toHaveBeenCalledExactlyOnceWith(callServiceUrlFor);
        expect(setServiceUrl.mock.invocationCallOrder[0]).toBeLessThan(initialize.mock.invocationCallOrder[0]);
        expect(ElementCall.getConfigOptions).toHaveBeenCalledWith();
    });

    it("lets Element Call join with the OpenID token kept warm for calls", async () => {
        const { loadElementCallComponent } = await import("./ElementCallLoader");
        const { elementCallOpenIdTokens } = await import("./ElementCallOpenIdToken");
        await loadElementCallComponent();
        expect(setOpenIdTokens).toHaveBeenCalledExactlyOnceWith(elementCallOpenIdTokens);
        expect(setOpenIdTokens.mock.invocationCallOrder[0]).toBeLessThan(initialize.mock.invocationCallOrder[0]);
    });

    it("allows a later join to retry failed background initialization", async () => {
        initialize.mockRejectedValueOnce(new Error("offline"));
        const { loadElementCallComponent } = await import("./ElementCallLoader");
        await expect(loadElementCallComponent()).rejects.toThrow("offline");
        await expect(loadElementCallComponent()).resolves.toEqual({ default: "call" });
        expect(initialize).toHaveBeenCalledTimes(2);
    });
});
