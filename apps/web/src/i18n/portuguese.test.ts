/*
Copyright 2026 Aether contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

type Dictionary = { [key: string]: string | Dictionary };

function flatten(dictionary: Dictionary, prefix = ""): Record<string, string> {
    return Object.fromEntries(
        Object.entries(dictionary).flatMap(([key, value]) =>
            typeof value === "string" ? [[prefix + key, value]] : Object.entries(flatten(value, `${prefix}${key}|`)),
        ),
    );
}

describe.each([
    ["web", "./strings/"],
    ["desktop", "../../../desktop/src/i18n/strings/"],
    ["shared components", "../../../../packages/shared-components/src/i18n/strings/"],
])("Brazilian Portuguese in %s", (_name, path) => {
    // Read fresh dictionaries because the language test setup merges shared strings into its JSON imports.
    const read = (locale: string): Dictionary =>
        JSON.parse(readFileSync(new URL(`${path}${locale}.json`, import.meta.url), "utf8"));
    const source = flatten(read("en_EN"));
    const translated = flatten(read("pt_BR"));

    it("should translate every English entry", () => {
        expect(Object.keys(source).filter((key) => !translated[key]?.trim())).toEqual([]);
    });

    it("should preserve substitution variables and rich text tags", () => {
        const tokens = (value: string): string[] => value.match(/%\([^)]+\)s|<\/?\w+\s*\/?>/g)?.sort() ?? [];
        // The developer tool uses <space> as literal text, not a replacement tag.
        const mismatches = Object.entries(source)
            .filter(([key]) => key !== "devtools|spaces|one")
            .filter(([key, value]) => JSON.stringify(tokens(translated[key] ?? "")) !== JSON.stringify(tokens(value)))
            .map(([key]) => key);
        expect(mismatches).toEqual([]);
    });
});
