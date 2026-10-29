# Translating Aether

Submit translation improvements through pull requests to [Aether](https://github.com/chopin014/Aether).
Use [Aether issues](https://github.com/chopin014/Aether/issues) to coordinate a new language or ask questions.

Renderer strings are in `apps/web/src/i18n/strings/<locale>.json`, shared-component strings in
`packages/shared-components/src/i18n/strings/<locale>.json`, and desktop strings in `apps/desktop/src/i18n/strings`.
Use the corresponding `en_EN.json` as the source of meaning and keep the existing nested structure.

Preserve placeholders such as `%(name)s` and `%(count)s`, plural forms, and markup such as `<link>...</link>`.
Translate complete messages with enough context for the screen where they appear.
Keep Aether's name and technical Matrix identifiers intact.

Use the [developer translation guide](translating-dev.md) when adding keys or changing source strings.
After editing translations, run `pnpm i18n:lint` and review the resulting UI for clipping and missing strings.
