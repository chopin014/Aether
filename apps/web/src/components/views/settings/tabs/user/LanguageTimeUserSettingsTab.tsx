/*
Copyright 2026 Gabriel
Copyright 2024, 2025 New Vector Ltd.
Copyright 2019-2023 The Matrix.org Foundation C.I.C.
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type ChangeEvent, type JSX, type ReactElement, useCallback, useEffect, useState } from "react";
import { SettingsToggleInput } from "@vector-im/compound-web";

import { type NonEmptyArray } from "../../../../../@types/common";
import { _t, getCurrentLanguage } from "../../../../../languageHandler";
import SettingsStore from "../../../../../settings/SettingsStore";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import SettingsFlag from "../../../elements/SettingsFlag";
import Dropdown from "../../../elements/Dropdown";
import LanguageDropdown from "../../../elements/LanguageDropdown";
import PlatformPeg from "../../../../../PlatformPeg";
import { IS_MAC } from "../../../../../Keyboard";
import SpellCheckSettings from "../../SpellCheckSettings";
import * as TimezoneHandler from "../../../../../TimezoneHandler";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SettingsSubsection } from "../../shared/SettingsSubsection";

/** The app's language. Changing it reloads the app. */
function LanguageSection(): JSX.Element {
    const [language, setLanguage] = useState(getCurrentLanguage());

    const onLanguageChange = useCallback(
        async (newLanguage: string) => {
            if (language === newLanguage) return;

            await SettingsStore.setValue("language", null, SettingLevel.DEVICE, newLanguage);
            setLanguage(newLanguage);
            const platform = PlatformPeg.get();
            if (platform) {
                await platform.setLanguage([newLanguage]);
                platform.reload();
            }
        },
        [language],
    );

    return (
        <div className="mx_SettingsSubsection_dropdown">
            {_t("settings|general|application_language")}
            <LanguageDropdown onOptionChange={onLanguageChange} value={language} />
            <div className="mx_LanguageTimeUserSettingsTab_hint">
                {_t("settings|general|application_language_reload_hint")}
            </div>
        </div>
    );
}

/** Spell checking, which only the desktop app offers. */
function SpellCheckSection(): JSX.Element | null {
    const [spellCheckEnabled, setSpellCheckEnabled] = useState<boolean | undefined>();
    const [spellCheckLanguages, setSpellCheckLanguages] = useState<string[] | undefined>();

    useEffect(() => {
        (async () => {
            const plaf = PlatformPeg.get();
            const [enabled, langs] = await Promise.all([plaf?.getSpellCheckEnabled(), plaf?.getSpellCheckLanguages()]);

            setSpellCheckEnabled(enabled);
            setSpellCheckLanguages(langs || undefined);
        })();
    }, []);

    const onSpellCheckEnabledChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        const enabled = e.target.checked;
        setSpellCheckEnabled(enabled);
        PlatformPeg.get()?.setSpellCheckEnabled(enabled);
    }, []);

    const onSpellCheckLanguagesChange = useCallback((languages: string[]): void => {
        setSpellCheckLanguages(languages);
        PlatformPeg.get()?.setSpellCheckLanguages(languages);
    }, []);

    if (!PlatformPeg.get()?.supportsSpellCheckSettings()) return null;

    return (
        <>
            <SettingsToggleInput
                name="allow_spellcheck"
                label={_t("settings|general|allow_spellcheck")}
                onChange={onSpellCheckEnabledChange}
                checked={Boolean(spellCheckEnabled)}
            />
            {spellCheckEnabled && spellCheckLanguages !== undefined && !IS_MAC && (
                <SpellCheckSettings languages={spellCheckLanguages} onLanguagesChange={onSpellCheckLanguagesChange} />
            )}
        </>
    );
}

/** The time zone times are shown in, searchable by name. */
function TimezoneSection(): JSX.Element {
    const [timezone, setTimezone] = useState(TimezoneHandler.getUserTimezone());
    const [timezones, setTimezones] = useState(TimezoneHandler.getAllTimezones());

    const onTimezoneChange = (tz: string): void => {
        setTimezone(tz);
        void TimezoneHandler.setUserTimezone(tz);
    };

    const onTimezoneSearchChange = (search: string): void => {
        const timezoneSearch = search.toLowerCase();
        setTimezones(
            timezoneSearch
                ? TimezoneHandler.getAllTimezones().filter((tz) => tz.toLowerCase().includes(timezoneSearch))
                : TimezoneHandler.getAllTimezones(),
        );
    };

    const browserTimezoneLabel = _t("settings|preferences|default_timezone", {
        timezone: TimezoneHandler.shortBrowserTimezone(),
    });
    // The browser's own time zone always comes first.
    const options = [
        <div key="">{browserTimezoneLabel}</div>,
        ...timezones.map((tz) => <div key={tz}>{tz}</div>),
    ] as NonEmptyArray<ReactElement & { key: string }>;

    return (
        <div className="mx_SettingsSubsection_dropdown">
            {_t("settings|preferences|user_timezone")}
            <Dropdown
                id="mx_dropdownUserTimezone"
                className="mx_dropdownUserTimezone"
                data-testid="mx_dropdownUserTimezone"
                searchEnabled={true}
                value={timezone}
                label={_t("settings|preferences|user_timezone")}
                placeholder={browserTimezoneLabel}
                onOptionChange={onTimezoneChange}
                onSearchChange={onTimezoneSearchChange}
            >
                {options}
            </Dropdown>
        </div>
    );
}

/** The Language & time settings page: the app's language, spell checking, and how times are shown. */
export function LanguageTimeUserSettingsTab(): JSX.Element {
    return (
        <SettingsTab data-testid="mx_LanguageTimeUserSettingsTab">
            <SettingsSection>
                <SettingsSubsection heading={_t("settings|general|language_section")} formWrap card>
                    <LanguageSection />
                    <SpellCheckSection />
                </SettingsSubsection>
                <SettingsSubsection heading={_t("settings|preferences|time_heading")} formWrap card>
                    <TimezoneSection />
                    <SettingsFlag name="showTwelveHourTimestamps" level={SettingLevel.ACCOUNT} />
                    <SettingsFlag name="alwaysShowTimestamps" level={SettingLevel.ACCOUNT} />
                </SettingsSubsection>
            </SettingsSection>
        </SettingsTab>
    );
}
