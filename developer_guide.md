# Aether developer guide

Aether is a pnpm and Nx monorepo. Use Node.js 22.18 or newer and the pinned pnpm version in `package.json`.

## Set up the repository

```sh
git clone https://github.com/chopin014/Aether.git
cd Aether
pnpm install
```

Base feature branches on `main`. Internal workspace and package names such as `element-web`, `element-desktop`,
and `@element-hq/web-shared-components` remain unchanged so build commands and imports continue to work.
See the [repository layout](docs/monorepo.md).

## Run the desktop app

Follow [Launch the actual application](docs/desktop-ui.md#launch-the-actual-application) for the renderer,
native host, desktop configuration, and Electron launch command. The same guide covers
[previewing changes without packaging](docs/desktop-ui.md#preview-changes-without-packaging).
Use the [release guide](docs/aether-releases.md) when testing installers or updates.

## Work on the renderer

From `apps/web`, run `pnpm start` and wait for webpack to finish. The development server listens on port 8080.
For the desktop shell, follow the desktop guide's configuration and launch steps; opening the renderer alone
is not a substitute for validating native window controls, desktop devices, or packaging.

Develop new views in `packages/shared-components` with Storybook and keep application logic in
`apps/web/src/viewmodels`. Read [MVVM](docs/MVVM.md) and [code_style.md](code_style.md).

## Validation

Run commands from the repository root unless a workspace is specified:

```sh
pnpm lint:fmt
pnpm lint:js
pnpm -r --workspace-concurrency=1 lint:types
```

Choose unit tests by their location:

- Co-located `apps/web/src/**/*.test.ts(x)`: `pnpm vitest run <path>`.
- Browser tests: `pnpm vitest run --project web-browser <path>`.
- Legacy `apps/web/test/**/*-test.ts(x)`: run `pnpm jest <path>` from `apps/web`.
- Shared-component tests: run `pnpm test:unit -- <path>` from `packages/shared-components`.
- Desktop tests: run `pnpm test:unit --run` from `apps/desktop`.

New behavior needs unit tests, including features behind flags. Prefer co-located Vitest tests.
See [Playwright](docs/playwright.md) for end-to-end tests and screenshot review.
Run `pnpm i18n` after changing translated strings. Documentation-only changes need formatting and link checks.

## Useful references

- [Contributing](CONTRIBUTING.md)
- [Configuration](docs/config.md)
- [Feature flags](docs/feature-flags.md)
- [Translations](docs/translating-dev.md)
- [Debugging](docs/debugging.md)
