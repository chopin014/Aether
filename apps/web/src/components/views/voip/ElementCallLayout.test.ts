/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface GridTiles {
    tileWidth: number;
    tileHeight: number;
    gap: number;
    columns: number;
}

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("@element-hq/element-call-component"), "utf8");

/** Returns the patched source between two markers, failing loudly if the build no longer contains them. */
function slice(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
}

/** Element Call's grid sizing, with the desktop shell switched on or off. */
function gridSizer(desktopShell: boolean): (width: number, height: number, count: number) => GridTiles {
    const body = slice("function aetherGridTiles(", "\n//#endregion");
    return new Function("aetherDesktopShell", "M8", "N8", `${body}\nreturn P8;`)(() => desktopShell, 17 / 9, 4 / 3);
}

/** Element Call's layout choice for a normal-sized window, with stand-in layout builders. */
function layoutChooser(desktopShell: boolean): (layoutMode: string, oneOnOne: object | null) => string {
    const body = slice("function f4(", "\nfunction p4(");
    const f4 = new Function(
        "aetherDesktopShell",
        "m4",
        "h4",
        "g4",
        "_4",
        "y4",
        "v4",
        "p4",
        "l4",
        `${body}\nreturn f4;`,
    )(
        () => desktopShell,
        () => "grid",
        () => "one-on-one-desktop",
        () => "spotlight-expanded",
        () => "spotlight-landscape",
        () => "spotlight-portrait",
        () => "one-on-one-mobile",
        () => false,
        3,
    );
    return (layoutMode, oneOnOne) =>
        f4({ windowMode: "normal", layoutMode, spotlightExpanded: false, oneOnOne, spotlight: [], grid: [] });
}

describe("Element Call desktop layout", () => {
    it("places two participants side by side as equal 16:9 tiles that fill the stage", () => {
        const tiles = gridSizer(true)(1540, 780, 2);
        expect(tiles.columns).toBe(2);
        expect(tiles.gap).toBe(8);
        // (1540 - 2 × 16 padding - 8 gap) / 2
        expect(tiles.tileWidth).toBe(750);
        expect(tiles.tileHeight).toBeCloseTo((750 * 9) / 16);
    });

    it("grows tiles with the stage on large monitors", () => {
        const small = gridSizer(true)(1540, 780, 2);
        const large = gridSizer(true)(3060, 1240, 2);
        expect(large.tileWidth).toBeGreaterThan(small.tileWidth * 1.5);
        // Limited by height: two rows of 16:9 would be smaller than one wide row.
        expect(large.columns).toBe(2);
    });

    it("chooses the column count that gives the largest tiles", () => {
        // Four tiles on a wide stage fit best as 2 × 2 rather than one cramped row.
        expect(gridSizer(true)(1540, 780, 4).columns).toBe(2);
        // On a very wide, short stage, a single row wins.
        expect(gridSizer(true)(3000, 400, 4).columns).toBe(4);
    });

    it("keeps a minimum tile width and lets very large calls scroll", () => {
        const tiles = gridSizer(true)(1000, 300, 60);
        expect(tiles.tileWidth).toBe(160);
        expect(tiles.columns).toBe(Math.floor((1000 - 32 + 8) / (160 + 8)));
    });

    it("leaves Element Call's own sizing alone outside the desktop shell", () => {
        expect(gridSizer(false)(1540, 780, 2).gap).toBe(20);
    });

    it("shows a two-person grid as equal tiles instead of a picture-in-picture in the desktop shell", () => {
        const oneOnOne = { local: {}, remote: { type: "user" } };
        expect(layoutChooser(true)("grid", oneOnOne)).toBe("grid");
        expect(layoutChooser(false)("grid", oneOnOne)).toBe("one-on-one-desktop");
        expect(layoutChooser(true)("spotlight", oneOnOne)).toBe("spotlight-landscape");
    });

    it("uses Discord's fixed avatar sizes in the desktop shell", () => {
        expect(source).toContain("ae = aetherDesktopShell() ? T < 124 ? 40 : 80 :");
    });
});
