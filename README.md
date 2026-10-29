<h1>
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/img/aether/aether-assinatura-horizontal-positivo.svg" />
        <img alt="Aether" src="docs/img/aether/aether-assinatura-horizontal-inverso.svg" height="48" />
    </picture>
</h1>

Aether is an open-source desktop app for communities to talk, share, and spend time together.
It brings text channels, direct messages, and drop-in voice into a Discord-style interface on the Matrix network.
Organize your community in a Space, move between conversations, and stay in voice while catching up on messages.

[Releases](https://github.com/chopin014/Aether/releases) ·
[Report an issue](https://github.com/chopin014/Aether/issues)

## What you can do

- **Bring your community together.** Organize Matrix Spaces into text and voice channels, with member lists,
  unread indicators, and channel notification controls.
- **Keep the conversation going.** Send direct messages, share files, reply, react, and follow threads.
- **Drop into voice.** See who's in a channel, join a call, and keep talking while browsing text channels.
  Microphone, deafen, device selection, and voice sound controls are close at hand.
- **Connect through Matrix.** Sign in with a Matrix account on your chosen homeserver and communicate across
  the network, with support for encrypted conversations, device verification, and account recovery.

## Project status

**Aether is in active development.** The desktop interface is still being built, and there is no production release yet.
Some screens and interactions remain unfinished. Linux and Windows are the first release targets, with Linux x64
AppImage and Windows x64 installer builds.

Voice channels require a homeserver with MatrixRTC calling services configured. Aether is a client and does not
include those server components.

See the [implementation status](docs/desktop-ui.md) for working features and remaining work, and the
[release guide](docs/aether-releases.md) for builds, installation, and updates.

## Development

Use Node.js 22.18 or newer and the repository's pinned pnpm version. Start with the
[desktop development guide](docs/desktop-ui.md#launch-the-actual-application) to build and run Aether locally.
For distributable packages, follow the [desktop build instructions](docs/aether-releases.md#development-build).

The repository contains:

- `apps/desktop` — the Electron desktop application and packaging.
- `apps/web` — the chat interface, application logic, and end-to-end tests.
- `packages/shared-components` — shared UI components.
- `modules` — optional runtime modules.
- `docs` — configuration, development, and release documentation.

Before contributing, read the [contribution guide](CONTRIBUTING.md) and [code style](code_style.md).
See the [Playwright guide](docs/playwright.md) for end-to-end testing and the
[translation guide](docs/translating.md) to help with localization.

## License

See the [license texts](LICENSE-AGPL-3.0) and [upstream copyright and license notices](NOTICE.md).
