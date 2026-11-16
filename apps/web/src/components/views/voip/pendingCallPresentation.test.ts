/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { pendingCallPresentation } from "./pendingCallPresentation";
import type { ElementCall } from "../../../models/Call";
import SettingsStore from "../../../settings/SettingsStore";

describe("pendingCallPresentation", () => {
    const callWith = (disconnect: () => Promise<void>): ElementCall =>
        ({
            roomId: "!voice:example.org",
            participants: new Map([[{}, new Set(["A"])]]),
            disconnect,
        }) as unknown as ElementCall;

    it("presents a call that is still loading as joining, with the user's microphone as they left it", () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => name === "audioInputMuted");
        const { state } = pendingCallPresentation(callWith(vi.fn()), "Lounge");
        expect(state).toMatchObject({
            phase: "joining",
            roomId: "!voice:example.org",
            roomName: "Lounge",
            participantCount: 1,
            localAudioEnabled: false,
            fatalError: null,
        });
        expect(state.renderAudioElement()).toBeNull();
    });

    it("leaves through the call, and does nothing for the engine's other actions", async () => {
        const disconnect = vi.fn().mockRejectedValue(new Error("not ready"));
        const { actions } = pendingCallPresentation(callWith(disconnect), "Lounge");
        actions.leaveCall();
        expect(disconnect).toHaveBeenCalledOnce();
        // A failed leave is logged, not thrown into the click that asked for it.
        await Promise.resolve();
        for (const action of ["joinCall", "toggleLocalAudio", "reconnect", "stopScreenShare"] as const) {
            expect(() => actions[action]()).not.toThrow();
        }
    });
});
