/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import postcssNested from "postcss-nested";
import postcssScss from "postcss-scss";

/*
 * Chrome keeps one list of what all the `:has()` rules style beyond the element with the `:has()`. Whenever that
 * element's `:has()` might have changed, which is whenever anything is added inside it or removed, every element
 * within it matching anything on the list is restyled. So one rule styling `svg`, `button` or `[class*="…"]` after a
 * `:has()` makes every other such `:has()` restyle every svg, button or element with a class within its element; and
 * a `:has()` on a container of the whole page or room restyles much of it whenever a message is added.
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const STYLESHEET_DIRS = ["apps/web/res/css", "packages/shared-components/src"];

/** Containers of the whole page or a whole room, which must not hold a `:has()` that styles what is within them. */
const PAGE_CONTAINERS = [
    ":root",
    "html",
    "body",
    ".mx_MatrixChat",
    ".mx_MatrixChat_wrapper",
    ".mx_RoomView",
    ".mx_RoomView_body",
    ".mx_MainSplit",
];

function stylesheets(): string[] {
    return STYLESHEET_DIRS.flatMap((dir) =>
        readdirSync(path.join(repoRoot, dir), { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".pcss") || file.endsWith(".module.css"))
            .map((file) => path.join(dir, file)),
    );
}

/** Splits `text` at each top-level character `isSeparator` accepts: outside brackets, parentheses and quotes. */
function splitTopLevel(text: string, isSeparator: (char: string) => boolean): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = "";
    for (const char of text) {
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "(" || char === "[") {
            depth++;
        } else if (char === ")" || char === "]") {
            depth--;
        } else if (depth === 0 && isSeparator(char)) {
            parts.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

/** The compounds of a complex selector, left to right, without the combinators between them. */
function compounds(selector: string): string[] {
    const spaced = splitTopLevel(selector, (char) => char === ">" || char === "+" || char === "~").join(" ");
    return splitTopLevel(spaced, (char) => /\s/.test(char)).filter(Boolean);
}

/** Removes the arguments of `:not()` and `:has()`, which never name the element a compound matches. */
function withoutNegationsAndHas(compound: string): string {
    let out = "";
    for (let i = 0; i < compound.length; i++) {
        const fn = [":not(", ":has("].find((name) => compound.startsWith(name, i));
        if (!fn) {
            out += compound[i];
            continue;
        }
        let depth = 0;
        let j = i + fn.length - 1;
        for (; j < compound.length; j++) {
            if (compound[j] === "(") depth++;
            else if (compound[j] === ")" && --depth === 0) break;
        }
        i = j;
    }
    return out;
}

/** Each selector in `source` that styles something after a `:has()` in a way that restyles much of the page. */
function problemsIn(source: string, file = "test.pcss"): string[] {
    const { root } = postcss([postcssNested()]).process(source, { from: file, syntax: postcssScss });
    const problems: string[] = [];
    root.walkRules((rule) => {
        if (!rule.selector.includes(":has(")) return;
        for (const raw of splitTopLevel(rule.selector, (char) => char === ",")) {
            const selector = raw.replace(/\s+/g, " ").trim();
            const parts = compounds(selector);
            let lastHas = parts.length - 1;
            while (lastHas >= 0 && !parts[lastHas].includes(":has(")) lastHas--;
            // A :has() on the element being styled restyles only that element.
            if (lastHas < 0 || lastHas === parts.length - 1) continue;
            const anchor = withoutNegationsAndHas(parts[lastHas]);
            const anchorNames = anchor.match(/^[a-z]+|[.#][\w-]+|:root/gi) ?? [];
            if (anchorNames.some((name) => PAGE_CONTAINERS.includes(name))) {
                problems.push(`${file}: ${selector}: a :has() on ${anchor} styles what is within it`);
            }
            const subject = withoutNegationsAndHas(parts[parts.length - 1]).replace(/\[[^\]]*\]/g, "");
            if (!/[.#][\w-]/.test(subject)) {
                problems.push(`${file}: ${selector}: what it styles after a :has() has no class`);
            }
        }
    });
    return problems;
}

describe("stylesheets", () => {
    it("style nothing after a :has() but elements named by a class, within small parts of the page", () => {
        const files = stylesheets();
        expect(files.length).toBeGreaterThan(100);
        expect(files.flatMap((file) => problemsIn(readFileSync(path.join(repoRoot, file), "utf8"), file))).toEqual([]);
    });

    it.each([
        [":root:has(.separator[data-active]) #container {}"],
        [".mx_MainSplit:has(.panel) .timeline {}"],
        [".shell .mx_RoomView:not(:has(.panel)) .header {}"],
        ['.tooltip:has([data-card]) [class*="_arrow_"] {}'],
        [".tooltip:has([data-card]) > span:first-of-type {}"],
        ['.header { &:hover, &:has(button[data-state="open"]) { svg { fill: red; } } }'],
        [".info:has(.actions) > button {}"],
    ])("reports %s", (source) => {
        expect(problemsIn(source)).toHaveLength(1);
    });

    it.each([
        [".tile:has(.call) .line {}"],
        [".tile:has(> .line .notice) > .line :is(.text, .source) {}"],
        [".tile:has(.call) {}"],
        [".mx_RoomView > .mx_RoomHeader ~ .mx_MainSplit .panel {}"],
        ['.tooltip > span:first-of-type:has(+ [class*="_caption_"] > [data-card]) {}'],
        [".mx_MainSplit > .mx_RoomView_body:has(~ .wrapper .thread) {}"],
    ])("accepts %s", (source) => {
        expect(problemsIn(source)).toEqual([]);
    });
});
