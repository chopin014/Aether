# Aether desktop

The Electron host for Aether, including native window integration, profiles, packaging, and updates.
The internal Nx workspace name is `element-desktop`.

## Build and run

Start with the [desktop development guide](../../docs/desktop-ui.md#launch-the-actual-application).
For Linux AppImage and Windows installer builds, follow the [Aether release guide](../../docs/aether-releases.md).
Use Aether's `config.desktop.json` and `build:aether` packaging command.

## Profiles

Launch `aether --profile Work` to use a separate profile. Use `--profile-dir /path/to/profile` for a custom location.
Do not run two app instances against the same profile directory.

## User-specified config.json

A user configuration can override the bundled settings. The default locations are:

- Windows: `%APPDATA%\Aether\config.json`
- Linux: `$XDG_CONFIG_HOME/Aether/config.json` or `~/.config/Aether/config.json`

With `--profile Work`, the directory name becomes `Aether-Work`.
You can supply another file with `--config /path/to/config.json` or `ELEMENT_DESKTOP_CONFIG_JSON`.
The environment variable retains its internal name. See [configuration](../../docs/config.md).

## Development and feedback

See the [developer guide](../../developer_guide.md), [debugging guide](../../docs/debugging.md), and
[contribution guide](../../CONTRIBUTING.md). Report problems in [Aether issues](https://github.com/chopin014/Aether/issues).

## License

See [upstream notices](../../NOTICE.md#desktop) and the license texts in the repository root.
