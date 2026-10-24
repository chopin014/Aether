/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { nativeAccelerator, parseKey, portalTrigger } from "./keys.js";

describe("shortcut keys", () => {
    it("should canonicalize modifiers and reject malformed or unbounded chords", () => {
        expect(parseKey("Shift+Control+KeyV")?.canonical).toBe("Control+Shift+KeyV");
        for (const key of ["", "Control+Control+KeyV", "Unknown+KeyV", "KeyAA", "x".repeat(81)])
            expect(parseKey(key)).toBeUndefined();
    });
    it("should map physical codes to each supported protocol", () => {
        expect(nativeAccelerator("Control+KeyV")).toBe("Control+V");
        expect(nativeAccelerator("Meta+Digit1")).toBe("Super+1");
        expect(nativeAccelerator("ControlLeft")).toBeUndefined();
        expect(portalTrigger("Control+Shift+KeyV")).toBe("CTRL+SHIFT+v");
        expect(portalTrigger("Alt+Space")).toBe("ALT+space");
        expect(portalTrigger("Meta+ArrowUp")).toBe("LOGO+Up");
        expect(portalTrigger("ShiftRight")).toBeUndefined();
    });
});
