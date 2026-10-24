/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { avoidWindowControls, readWindowControls } from "./windowControls";

const controls = { inline: 138, block: 48 };

describe("avoidWindowControls", () => {
    it("leaves everything alone when there are no controls", () => {
        const box = { top: 0, left: 1000, width: 280, height: 100 };
        expect(avoidWindowControls(box, { inline: 0, block: 0 }, 1280)).toEqual({ top: 0, left: 1000 });
    });

    it("leaves boxes below the controls alone", () => {
        const box = { top: 48, left: 1000, width: 280, height: 100 };
        expect(avoidWindowControls(box, controls, 1280)).toEqual({ top: 48, left: 1000 });
    });

    it("leaves boxes left of the controls alone", () => {
        const box = { top: 8, left: 700, width: 280, height: 100 };
        expect(avoidWindowControls(box, controls, 1280)).toEqual({ top: 8, left: 700 });
    });

    it("moves a box under the controls to their left", () => {
        const box = { top: 8, left: 1000, width: 280, height: 100 };
        expect(avoidWindowControls(box, controls, 1280)).toEqual({ top: 8, left: 854 });
    });

    it("moves a box down when there is no room to its left", () => {
        const box = { top: 8, left: 8, width: 380, height: 100 };
        expect(avoidWindowControls(box, controls, 400)).toEqual({ top: 56, left: 8 });
    });
});

describe("readWindowControls", () => {
    it("is empty without the shell variables", () => {
        expect(readWindowControls()).toEqual({ inline: 0, block: 0 });
    });
});
