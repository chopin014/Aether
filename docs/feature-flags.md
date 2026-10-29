# Feature flags

Use flags to develop and validate unfinished behavior before enabling it for all Aether users.
Feature flags do not replace tests, accessibility checks, or review of real Matrix state transitions.

## Add a flag

Define the setting in `apps/web/src/settings/Settings.tsx` with `isFeature: true`, `supportedLevels: LEVELS_FEATURE`,
a translated display name, and `default: false`. Check it through `SettingsStore.getValue("feature_name")`.
Document the behavior and server requirements in [Labs](labs.md), and run `pnpm i18n` for new display strings.

## Enable it in a build

Set a flag under `features` in your `config.json`:

```json
{
    "features": {
        "feature_desktop_shell": true
    }
}
```

Aether's desktop defaults are in `apps/desktop/config.desktop.json`. Keep tests for both enabled and disabled
paths while both are supported. Flags depending on unstable Matrix features must handle missing server support.

## Complete or remove a feature

Before enabling a feature by default, validate its happy path in Playwright and review its UI, keyboard access,
and error states. Remove obsolete flag checks and documentation together. Preserve a user setting when the
behavior still needs to be configurable.
