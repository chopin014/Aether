/*
Copyright 2026 Aether contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import fetchMock from "@fetch-mock/vitest";
import { merge } from "lodash";
import { _t, getLocale } from "@element-hq/web-shared-components";
import { mockPlatformPeg, unmockPlatformPeg } from "test-utils/platform.ts";

import { getUserLanguage, setLanguage } from "./settings";
import SettingsStore from "../settings/SettingsStore";
import webPortuguese from "./strings/pt_BR.json";
// Read the shared catalog directly to exercise the same merged translations as the app build.
// oxlint-disable-next-line no-restricted-imports
import sharedPortuguese from "../../../../packages/shared-components/src/i18n/strings/pt_BR.json";

afterEach(async () => {
    vi.restoreAllMocks();
    unmockPlatformPeg();
    await setLanguage("en");
});

describe("setLanguage", () => {
    it("should render web and shared controls in Brazilian Portuguese with substitutions and plurals", async () => {
        fetchMock.modifyRoute("languages", {
            response: { "en": "en_EN.json", "pt-br": "pt_BR.json" },
        });
        fetchMock.get("end:pt_BR.json", merge({}, webPortuguese, sharedPortuguese));

        await setLanguage("pt-BR");

        expect(getLocale()).toBe("pt-br");
        expect(_t("desktop|text_channels")).toBe("Canais de texto");
        // The web key type excludes shared entries, which are merged into the catalog at runtime.
        const sharedKey = "pinned_messages|empty_title" as TranslationKey;
        expect(_t(sharedKey)).toBe("Ainda não há mensagens fixadas");
        const soundboardTitleKey = "desktop|soundboard|title" as TranslationKey;
        const soundboardEditKey = "desktop|soundboard|edit" as TranslationKey;
        expect(_t(soundboardTitleKey)).toBe("Painel de sons");
        expect(_t(soundboardEditKey, { name: "Aplausos" })).toBe("Editar Aplausos");
        expect(_t("poll|option_label_with_total", { number: 1, answer: "Sim", count: 1 })).toBe("Opção 1, Sim, 1 voto");
        expect(_t("poll|option_label_with_total", { number: 1, answer: "Sim", count: 2 })).toBe(
            "Opção 1, Sim, 2 votos",
        );
        expect(_t("room|intro|desktop_server_welcome", {}, { serverName: "Aether" })).toBe("Boas-vindas a Aether");
    });

    it("should normalize language tags and send the resolved language to the desktop host", async () => {
        const platform = mockPlatformPeg({ setLanguage: vi.fn() });
        await setLanguage("de-DE");
        expect(getLocale()).toBe("de");
        expect(platform.setLanguage).toHaveBeenCalledWith(["de"]);
    });

    it("should use the detected language for dates and other locale formatting", async () => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(null);
        vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
        await setLanguage("de");
        expect(getUserLanguage()).toBe("de");
    });

    it("should not save automatic detection as an explicit device preference", async () => {
        const save = vi.spyOn(SettingsStore, "setValue");
        await setLanguage("de");
        expect(save).not.toHaveBeenCalled();
    });

    it("should fall back to English for unsupported preferences", async () => {
        const platform = mockPlatformPeg({ setLanguage: vi.fn() });
        await setLanguage("zz-ZZ");
        expect(getLocale()).toBe("en");
        expect(platform.setLanguage).toHaveBeenCalledWith(["en"]);
    });
});
