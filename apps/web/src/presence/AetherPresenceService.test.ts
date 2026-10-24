/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetPresence } from "matrix-js-sdk/src/matrix";

import { AetherPresenceService } from "./AetherPresenceService";
import { makeFakeClient, makeFakeCrypto } from "../test/test-utils/aetherPresence";
import SettingsStore from "../settings/SettingsStore";
import Presence from "../Presence";

describe("AetherPresenceService", () => {
    let flags: Record<string, boolean>;
    let desired: SetPresence;
    let listener: ((p: SetPresence) => void) | undefined;
    const service = AetherPresenceService.instance;

    beforeEach(() => {
        flags = { feature_desktop_shell: true, lowBandwidth: false };
        desired = SetPresence.Online;
        listener = undefined;
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) => flags[name]) as never);
        vi.spyOn(Presence, "forClient").mockReturnValue({
            getDesired: () => desired,
            watchDesired: (cb: (p: SetPresence) => void) => {
                listener = cb;
                return () => (listener = undefined);
            },
        } as never);
    });
    afterEach(() => {
        service.stop();
        vi.restoreAllMocks();
    });

    const client = () =>
        makeFakeClient({ crypto: makeFakeCrypto(), rooms: [{ id: "!r", members: ["@bob:example.org"] }] });

    it("starts nothing when the desktop shell flag is off", async () => {
        flags.feature_desktop_shell = false;
        const c = client();
        service.start(c);
        await new Promise((r) => setTimeout(r, 0));
        expect(service.store).toBeUndefined();
        expect(service.activity).toBeUndefined();
        expect(Presence.forClient).not.toHaveBeenCalled();
        expect(c.queueToDevice).not.toHaveBeenCalled();
        expect(c.listenerCount("receivedToDeviceMessage")).toBe(0);
    });

    it("starts nothing in low bandwidth mode", () => {
        flags.lowBandwidth = true;
        service.start(client());
        expect(service.store).toBeUndefined();
    });

    it("broadcasts at start, follows preference changes, and tears everything down on stop", async () => {
        const c = client();
        service.start(c);
        expect(service.store).toBeDefined();
        expect(service.activity).toBeDefined();
        expect(c.listenerCount("receivedToDeviceMessage")).toBe(1);
        await new Promise((r) => setTimeout(r, 0));
        expect(c.queueToDevice).toHaveBeenCalledTimes(1);

        listener?.(SetPresence.Unavailable);
        await new Promise((r) => setTimeout(r, 0));
        expect(c.queueToDevice).toHaveBeenCalledTimes(2);

        service.stop();
        expect(service.store).toBeUndefined();
        expect(service.activity).toBeUndefined();
        expect(listener).toBeUndefined();
        expect(c.listenerCount("receivedToDeviceMessage")).toBe(0);
    });

    it("sends offline when the page is hidden", async () => {
        const c = client();
        service.start(c);
        await new Promise((r) => setTimeout(r, 0));
        window.dispatchEvent(new Event("pagehide"));
        await new Promise((r) => setTimeout(r, 0));
        expect(c.queueToDevice).toHaveBeenCalledTimes(2);
        expect(service.store).toBeUndefined();
    });
});
