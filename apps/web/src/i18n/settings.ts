/*
 * Copyright 2025 New Vector Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { logger } from "matrix-js-sdk/src/logger";
import {
    normalizeLanguageKey,
    getNormalizedLanguageKeys,
    getLangsJson,
    registerTranslations,
    setLocale,
} from "@element-hq/web-shared-components";

import SettingsStore from "../settings/SettingsStore";
import PlatformPeg from "../PlatformPeg";
import { getLanguageRetry } from "./languages";
import { getLanguageFromBrowser } from "./browser";
import { registerCustomTranslations } from "./custom";

let detectedLanguage: string | undefined;

export function getUserLanguage(): string {
    const language = SettingsStore.getValue("language", null, /*excludeDefault:*/ true);
    if (typeof language === "string" && language !== "") {
        return language;
    } else {
        return detectedLanguage ?? normalizeLanguageKey(getLanguageFromBrowser());
    }
}

export async function setLanguage(...preferredLangs: string[]): Promise<void> {
    const availableLanguages = await getLangsJson();
    let chosenLanguage = preferredLangs
        .flatMap(getNormalizedLanguageKeys)
        .find((lang) => availableLanguages.hasOwnProperty(lang));
    if (!chosenLanguage) {
        // Fallback to en_EN if none is found
        chosenLanguage = "en";
        logger.error("Unable to find an appropriate language, preferred: ", preferredLangs);
    }

    const languageData = await getLanguageRetry(availableLanguages[chosenLanguage]);

    registerTranslations(chosenLanguage, languageData);
    setLocale(chosenLanguage);
    detectedLanguage = chosenLanguage;

    // Only explicit choices in settings should override the system language on future launches.
    await PlatformPeg.get()?.setLanguage([chosenLanguage]);
    // Adds a lot of noise to test runs, so disable logging there.
    // oxlint-disable-next-line node/no-process-env
    if (process.env.NODE_ENV !== "test") {
        logger.log("set language to " + chosenLanguage);
    }

    // Set 'en' as fallback language:
    if (chosenLanguage !== "en") {
        const fallbackLanguageData = await getLanguageRetry(availableLanguages["en"]);
        registerTranslations("en", fallbackLanguageData);
    }

    await registerCustomTranslations();
}
