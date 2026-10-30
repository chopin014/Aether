/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { isHexColour, profileThemeStyle } from "./profileTheme";

describe("isHexColour", () => {
    it("accepts only six-digit hex colours", () => {
        expect(isHexColour("#A1b2C3")).toBe(true);
        for (const value of ["#abc", "red", "url(evil)", "#12345g", 1, null, "#123456;background:red"]) {
            expect(isHexColour(value)).toBe(false);
        }
    });
});

describe("profileThemeStyle", () => {
    it("picks the text colour family from the theme", () => {
        expect(profileThemeStyle({ primary: "#101018", accent: "#2a0a40" }).tone).toBe("dark");
        expect(profileThemeStyle({ primary: "#f0f4ff", accent: "#ffe8f0" }).tone).toBe("light");
    });

    it("washes the surface further when the colours alone would make text hard to read", () => {
        const wash = (primary: string, accent: string): number =>
            Number.parseInt(
                (profileThemeStyle({ primary, accent }).style as Record<string, string>)["--profile-wash"],
                10,
            );
        const gentle = wash("#101018", "#20202c");
        const extreme = wash("#000000", "#ffffff");
        expect(extreme).toBeGreaterThan(gentle);
        expect(extreme).toBeLessThanOrEqual(90);
    });
});
