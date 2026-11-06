/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { matchesCategory } from "./discoverCategories";

describe("matchesCategory", () => {
    it("puts everything in Home", () => {
        expect(matchesCategory("home", "Anything")).toBe(true);
    });

    it("matches whole words in the name or topic, in several languages", () => {
        expect(matchesCategory("gaming", "Video Games")).toBe(true);
        expect(matchesCategory("gaming", "Comunidade", "Jogos e diversão")).toBe(true);
        expect(matchesCategory("gaming", "Dungeons & Dragons (Unofficial)")).toBe(true);
        expect(matchesCategory("music", "Rock & Metal Music")).toBe(true);
        expect(matchesCategory("tech", "CalyxOS", "An Android distribution")).toBe(true);
        expect(matchesCategory("education", "Language Exchange", "Find languages partners")).toBe(true);
        expect(matchesCategory("entertainment", "Stickers and emojis")).toBe(true);
    });

    it("does not match parts of words or common topic boilerplate", () => {
        expect(matchesCategory("gaming", "Gamelan orchestra")).toBe(false);
        expect(matchesCategory("tech", "Cooking", "Read the code of conduct in this space on Matrix")).toBe(false);
        expect(matchesCategory("music", "Rockets")).toBe(false);
    });
});
