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

/** The selector list in each `:is()`, `:where()`, `:not()` or `:has()` at the top level of a compound. */
interface PseudoArgument {
    name: "is" | "where" | "not" | "has";
    selectors: string[];
}

/** Splits a compound into what it says of the element itself and the selector lists of its functional pseudos. */
function splitCompound(compound: string): { own: string; pseudos: PseudoArgument[] } {
    let own = "";
    const pseudos: PseudoArgument[] = [];
    for (let i = 0; i < compound.length; i++) {
        const match = /^:(is|where|not|has)\(/.exec(compound.slice(i));
        if (compound[i] === "[") {
            // An attribute selector's value can hold anything, so it is kept whole.
            const close = compound.indexOf("]", i);
            own += compound.slice(i, close + 1);
            i = close;
        } else if (match) {
            let depth = 0;
            let j = i + match[0].length - 1;
            for (; j < compound.length; j++) {
                if (compound[j] === "(") depth++;
                else if (compound[j] === ")" && --depth === 0) break;
            }
            const name = match[1] as PseudoArgument["name"];
            const list = compound.slice(i + match[0].length, j);
            pseudos.push({ name, selectors: splitTopLevel(list, (char) => char === ",").map((s) => s.trim()) });
            i = j;
        } else {
            own += compound[i];
        }
    }
    return { own, pseudos };
}

/** The type, classes and ids a compound matches its element by, including those in its `:is()` and `:where()`. */
function namesOf(compound: string): string[] {
    const { own, pseudos } = splitCompound(compound);
    const names: string[] = [...(own.replace(/\[[^\]]*\]/g, "").match(/^[a-z][\w-]*|[.#][\w-]+|:root/gi) ?? [])];
    for (const pseudo of pseudos) {
        if (pseudo.name !== "is" && pseudo.name !== "where") continue;
        for (const selector of pseudo.selectors) names.push(...namesOf(compounds(selector).at(-1) ?? ""));
    }
    return names;
}

/**
 * Whether a compound matches only elements with some class or id. Through `:is()` and `:where()`, that has to hold
 * for every selector in the list: `:is(.icon, span)` matches any span.
 */
function namedByClass(compound: string): boolean {
    const { own, pseudos } = splitCompound(compound);
    if (/[.#][\w-]/.test(own.replace(/\[[^\]]*\]/g, ""))) return true;
    return pseudos.some(
        (pseudo) =>
            (pseudo.name === "is" || pseudo.name === "where") &&
            pseudo.selectors.every((selector) => namedByClass(compounds(selector).at(-1) ?? "")),
    );
}

/** The problems with one selector list: each complex selector in it, and each in its pseudos' selector lists. */
function problemsInSelectors(selectorList: string, file: string): string[] {
    const problems: string[] = [];
    for (const raw of splitTopLevel(selectorList, (char) => char === ",")) {
        const selector = raw.replace(/\s+/g, " ").trim();
        const parts = compounds(selector);
        parts.forEach((part, index) => {
            for (const pseudo of splitCompound(part).pseudos) {
                // A :has() takes relative selectors, which cannot hold another :has().
                if (pseudo.name !== "has") problems.push(...problemsInSelectors(pseudo.selectors.join(", "), file));
            }
            // A :has() on the element being styled restyles only that element.
            if (index === parts.length - 1 || !part.includes(":has(")) return;
            const anchor = namesOf(part).filter((name) => PAGE_CONTAINERS.includes(name));
            if (anchor.length > 0) {
                problems.push(`${file}: ${selector}: a :has() on ${anchor.join("")} styles what is within it`);
            }
            if (!namedByClass(parts[parts.length - 1])) {
                problems.push(`${file}: ${selector}: what it styles after a :has() has no class`);
            }
        });
    }
    return problems;
}

/** Each selector in `source` that styles something after a `:has()` in a way that restyles much of the page. */
function problemsIn(source: string, file = "test.pcss"): string[] {
    const { root } = postcss([postcssNested()]).process(source, { from: file, syntax: postcssScss });
    const problems: string[] = [];
    root.walkRules((rule) => {
        if (rule.selector.includes(":has(")) problems.push(...problemsInSelectors(rule.selector, file));
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
        [".mx_RoomView:has(.panel) .tile:has(.notice) {}"],
        [":is(.mx_RoomView:has(.panel) .header) {}"],
        [":where(.mx_RoomView:has(.panel) .header) {}"],
        [":is(.mx_RoomView:has(.panel)) .header {}"],
        [".tile:has(.panel) :is(.icon, span) {}"],
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
        [".button:not(:hover, :focus-visible):has(.badge [data-type]) .wrapper::before {}"],
        [".tile:has(.panel) span:is(.icon) {}"],
        [".mx_RoomView:not(.other):has(> .header) {}"],
    ])("accepts %s", (source) => {
        expect(problemsIn(source)).toEqual([]);
    });
});
