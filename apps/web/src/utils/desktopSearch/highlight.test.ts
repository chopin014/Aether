/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { highlightSegments, termsFromText } from "./highlight";

describe("highlightSegments", () => {
    it("returns the whole body when there is nothing to highlight", () => {
        expect(highlightSegments("hello", [])).toEqual([{ text: "hello", match: false }]);
        expect(highlightSegments("", ["a"])).toEqual([{ text: "", match: false }]);
    });

    it("marks matches while keeping the original casing", () => {
        expect(highlightSegments("The Budget is ready, budget!", ["budget"])).toEqual([
            { text: "The ", match: false },
            { text: "Budget", match: true },
            { text: " is ready, ", match: false },
            { text: "budget", match: true },
            { text: "!", match: false },
        ]);
    });

    it("prefers longer terms and escapes regular expression characters", () => {
        expect(highlightSegments("cost (usd) is 1+1", ["(usd)", "1+1", "us"])).toEqual([
            { text: "cost ", match: false },
            { text: "(usd)", match: true },
            { text: " is ", match: false },
            { text: "1+1", match: true },
        ]);
    });
});

describe("termsFromText", () => {
    it("splits words, drops quotes and one-letter words", () => {
        expect(termsFromText('"exact phrase" a budget')).toEqual(["exact", "phrase", "budget"]);
    });
});
