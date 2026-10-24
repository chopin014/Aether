/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
    isEmptyQuery,
    isSameQuery,
    parseIsoDate,
    parseQuery,
    pendingFilter,
    quoteValue,
    serializeQuery,
    type FilterValueResolver,
} from "./query";

const resolver: FilterValueResolver = (key, raw) => {
    if (key === "from" && raw === "Alice Smith") return { value: "@alice:x", label: "Alice Smith" };
    if (key === "in" && raw === "general") return { value: "!gen:x", label: "general" };
    return null;
};

describe("quoteValue", () => {
    it("leaves simple values alone and quotes the rest", () => {
        expect(quoteValue("alice")).toBe("alice");
        expect(quoteValue("Alice Smith")).toBe('"Alice Smith"');
        expect(quoteValue('say "hi"')).toBe('"say \\"hi\\""');
        expect(quoteValue("")).toBe('""');
    });
});

describe("parseIsoDate", () => {
    it("accepts real dates as local midnight", () => {
        expect(parseIsoDate("2026-03-28")).toBe(new Date(2026, 2, 28).getTime());
    });

    it.each(["2026-02-30", "2026-13-01", "28/03/2026", "yesterday", ""])("rejects %j", (value) => {
        expect(parseIsoDate(value)).toBeNull();
    });
});

describe("parseQuery", () => {
    it("returns plain text untouched", () => {
        expect(parseQuery("hello   world")).toEqual({ text: "hello world", filters: [] });
    });

    it("turns self-describing filters into tokens", () => {
        expect(parseQuery("has:file pinned:TRUE during:2026-03-28 report")).toEqual({
            text: "report",
            filters: [
                { key: "has", value: "file" },
                { key: "pinned", value: "true" },
                { key: "during", value: "2026-03-28" },
            ],
        });
    });

    it("accepts literal Matrix IDs without a resolver", () => {
        expect(parseQuery("from:@bob:x mentions:@eve:y in:!room:x").filters).toEqual([
            { key: "from", value: "@bob:x" },
            { key: "mentions", value: "@eve:y" },
            { key: "in", value: "!room:x" },
        ]);
    });

    it("resolves quoted names through the resolver", () => {
        expect(parseQuery('from:"Alice Smith" in:general budget', resolver)).toEqual({
            text: "budget",
            filters: [
                { key: "from", value: "@alice:x", label: "Alice Smith" },
                { key: "in", value: "!gen:x", label: "general" },
            ],
        });
    });

    it("keeps unresolved or invalid filters in the text", () => {
        expect(parseQuery("from:nobody has:poll before:soon colour:red", resolver)).toEqual({
            text: "from:nobody has:poll before:soon colour:red",
            filters: [],
        });
    });

    it("keeps quoted phrases as text", () => {
        expect(parseQuery('"exact phrase" has:link').text).toBe('"exact phrase"');
    });

    it("drops duplicates and lets single-valued filters be replaced", () => {
        expect(parseQuery("has:file has:file has:image pinned:true pinned:false").filters).toEqual([
            { key: "has", value: "file" },
            { key: "has", value: "image" },
            { key: "pinned", value: "false" },
        ]);
    });

    it("is case-insensitive about keys", () => {
        expect(parseQuery("HAS:Image").filters).toEqual([{ key: "has", value: "image" }]);
    });
});

describe("serializeQuery", () => {
    it("writes filters before the text using labels and quotes", () => {
        expect(
            serializeQuery({
                text: " budget ",
                filters: [
                    { key: "from", value: "@alice:x", label: "Alice Smith" },
                    { key: "has", value: "file" },
                ],
            }),
        ).toBe('from:"Alice Smith" has:file budget');
    });

    it("round-trips through the parser", () => {
        const query = {
            text: "budget q3",
            filters: [
                { key: "from" as const, value: "@alice:x", label: "Alice Smith" },
                { key: "in" as const, value: "!gen:x", label: "general" },
                { key: "after" as const, value: "2026-01-01" },
            ],
        };
        expect(parseQuery(serializeQuery(query), resolver)).toEqual(query);
    });
});

describe("query comparison", () => {
    it("treats filter order as irrelevant", () => {
        const a = parseQuery("has:file pinned:true x");
        const b = parseQuery("pinned:true has:file x");
        expect(isSameQuery(a, b)).toBe(true);
        expect(isSameQuery(a, parseQuery("has:file x"))).toBe(false);
    });

    it("detects empty queries", () => {
        expect(isEmptyQuery({ text: "  ", filters: [] })).toBe(true);
        expect(isEmptyQuery(parseQuery("has:file"))).toBe(false);
    });
});

describe("pendingFilter", () => {
    it("reads the key being typed at the end", () => {
        expect(pendingFilter("budget from:ali")).toEqual({ key: "from", partial: "ali", start: 7 });
        expect(pendingFilter("has:")).toEqual({ key: "has", partial: "", start: 0 });
        expect(pendingFilter('from:"Alice S')).toEqual({ key: "from", partial: "Alice S", start: 0 });
    });

    it("ignores unknown keys and finished words", () => {
        expect(pendingFilter("colour:re")).toBeNull();
        expect(pendingFilter("from:alice ")).toBeNull();
        expect(pendingFilter("plain")).toBeNull();
    });
});
