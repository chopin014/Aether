/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it } from "vitest";

import { addRecentSearch, clearRecentSearches, loadRecentSearches } from "./recents";
import { parseQuery } from "./query";

function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() {
            return data.size;
        },
        clear: () => data.clear(),
        getItem: (key) => data.get(key) ?? null,
        key: (index) => [...data.keys()][index] ?? null,
        removeItem: (key) => void data.delete(key),
        setItem: (key, value) => void data.set(key, value),
    };
}

describe("recent searches", () => {
    let storage: Storage;
    beforeEach(() => {
        storage = memoryStorage();
    });

    it("starts empty", () => {
        expect(loadRecentSearches("@a:x", storage)).toEqual([]);
    });

    it("stores newest first and moves repeats to the front", () => {
        addRecentSearch("@a:x", parseQuery("budget"), storage);
        addRecentSearch("@a:x", parseQuery("has:file report"), storage);
        const after = addRecentSearch("@a:x", parseQuery("budget"), storage);
        expect(after.map((query) => query.text)).toEqual(["budget", "report"]);
        expect(loadRecentSearches("@a:x", storage)).toEqual(after);
    });

    it("keeps filters with their labels", () => {
        addRecentSearch("@a:x", { text: "", filters: [{ key: "from", value: "@b:x", label: "Bob" }] }, storage);
        expect(loadRecentSearches("@a:x", storage)[0].filters[0]).toEqual({ key: "from", value: "@b:x", label: "Bob" });
    });

    it("keeps at most ten", () => {
        for (let i = 0; i < 15; i++) addRecentSearch("@a:x", parseQuery(`term${i}`), storage);
        const recents = loadRecentSearches("@a:x", storage);
        expect(recents).toHaveLength(10);
        expect(recents[0].text).toBe("term14");
    });

    it("is separate for each account", () => {
        addRecentSearch("@a:x", parseQuery("mine"), storage);
        expect(loadRecentSearches("@b:x", storage)).toEqual([]);
    });

    it("clears", () => {
        addRecentSearch("@a:x", parseQuery("mine"), storage);
        clearRecentSearches("@a:x", storage);
        expect(loadRecentSearches("@a:x", storage)).toEqual([]);
    });

    it("ignores corrupted storage", () => {
        storage.setItem("mx_desktop_search_recents_@a:x", "{not json");
        expect(loadRecentSearches("@a:x", storage)).toEqual([]);
        storage.setItem("mx_desktop_search_recents_@a:x", JSON.stringify([{ text: 1 }, { text: "ok", filters: [] }]));
        expect(loadRecentSearches("@a:x", storage)).toEqual([{ text: "ok", filters: [] }]);
    });
});
