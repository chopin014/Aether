/*
Copyright 2026 Aether contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import counterpart from "counterpart";

import { AppLocalization, _t } from "./language-helper.js";
import type Store from "./store.js";

function createLocalization(languages: string[], savedLocale?: string[]): AppLocalization {
    const store = {
        has: vi.fn().mockReturnValue(Boolean(savedLocale)),
        get: vi.fn().mockReturnValue(savedLocale),
        set: vi.fn(),
    } as unknown as Store;
    return new AppLocalization({ components: [], store, languages });
}

afterEach(() => {
    counterpart.setLocale("en");
});

describe("AppLocalization", () => {
    it("should use Brazilian Portuguese system preferences before the renderer starts", () => {
        createLocalization(["pt-BR", "en-US"]);
        expect(_t("save_dialog|all_files")).toBe("Todos os arquivos");
    });

    it("should skip unavailable languages instead of choosing an empty dictionary", () => {
        createLocalization(["zz-ZZ", "pt_BR"]);
        expect(_t("save_dialog|all_files")).toBe("Todos os arquivos");
    });

    it("should fall back to English when no preferred language is supported", () => {
        createLocalization(["zz-ZZ"]);
        expect(_t("save_dialog|all_files")).toBe("All Files");
    });

    it("should use a saved language preference", () => {
        createLocalization(["en-US"], ["pt-BR"]);
        expect(_t("save_dialog|all_files")).toBe("Todos os arquivos");
    });

    it("should refresh localized components when the renderer changes language", () => {
        const localization = createLocalization(["en"]);
        localization.setAppLocale(["pt-br"]);
        expect(_t("download|unable_to_open_title")).toBe("Não foi possível abrir o arquivo");
    });
});
