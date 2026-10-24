/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { placeProfilePopout } from "./profilePopoutPlacement";

const card = { width: 340, height: 300 };
const viewport = { width: 1200, height: 800 };

describe("placeProfilePopout", () => {
    it("sits to the right of the anchor, aligned with its top", () => {
        expect(placeProfilePopout({ top: 100, left: 300, width: 40, height: 40 }, card, viewport)).toEqual({
            top: 100,
            left: 348,
            side: "right",
        });
    });

    it("flips to the left near the right edge, as for the member list", () => {
        expect(placeProfilePopout({ top: 100, left: 1000, width: 180, height: 44 }, card, viewport)).toEqual({
            top: 100,
            left: 652,
            side: "left",
        });
    });

    it("shifts up to stay inside the viewport near the bottom", () => {
        expect(placeProfilePopout({ top: 750, left: 300, width: 40, height: 40 }, card, viewport).top).toBe(492);
    });

    it("never starts above the viewport", () => {
        expect(placeProfilePopout({ top: -50, left: 300, width: 40, height: 40 }, card, viewport).top).toBe(8);
    });

    it("goes below, then above, when neither side fits", () => {
        const narrow = { width: 360, height: 800 };
        expect(placeProfilePopout({ top: 100, left: 100, width: 100, height: 40 }, card, narrow)).toMatchObject({
            side: "below",
            top: 148,
        });
        expect(placeProfilePopout({ top: 700, left: 100, width: 100, height: 40 }, card, narrow)).toMatchObject({
            side: "above",
            top: 392,
        });
    });

    it("keeps a below placement horizontally inside the viewport", () => {
        const result = placeProfilePopout({ top: 100, left: 300, width: 100, height: 40 }, card, {
            width: 360,
            height: 800,
        });
        expect(result.left).toBe(12);
    });
});
