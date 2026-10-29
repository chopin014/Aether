# Repository layout

Aether uses pnpm workspaces and Nx to build its desktop host, renderer, shared components, and runtime modules.

- `apps/desktop` — Electron host, native integration, desktop configuration, and release packaging.
- `apps/web` — renderer, application logic, view models, Jest/Vitest tests, and Playwright end-to-end tests.
- `packages/shared-components` — React views, CSS modules, Storybook, and view-model contracts.
- `packages/module-api` — API for optional runtime modules.
- `packages/shared-utils`, `packages/shared-types`, `packages/playwright-common` — supporting code and test helpers.
- `modules` — optional runtime modules.
- `docs` — developer and configuration references, plus the VitePress documentation build.

The internal workspace names `element-web` and `element-desktop`, package scopes, and protocol identifiers are
inherited names used by the code and build system. They do not identify the product as Aether.

## Branches and releases

`main` is Aether's integration branch. Create focused feature branches from it and target `main` in pull requests.
Aether desktop tags use `v<semver>`. See the [release guide](aether-releases.md) for build and publication steps.
Shared packages are built locally as part of the app; Aether does not publish packages under the inherited npm scopes.
