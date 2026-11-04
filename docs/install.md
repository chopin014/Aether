# Installing Aether

Download Aether builds from [GitHub Releases](https://github.com/chopin014/Aether/releases).
The release targets are Linux x64 AppImage and Windows x64 installer.
See the [release guide](aether-releases.md#update-behavior-and-platform-support) for platform limitations,
first installation, and automatic updates.

A Matrix account is required. Voice channels also need a homeserver with MatrixRTC calling services configured;
installing the client does not install a homeserver or calling services.

## Linux AppImage setup

Keep the installed AppImage at a writable, version-free path such as `~/.local/opt/aether/Aether.AppImage`.
The updater preserves a custom filename without a version. A versioned filename can change during an update,
breaking shortcuts or symlinks that still point to the old filename.

From a source checkout with Node.js 22.18 or newer, install a downloaded release and its application-menu entry:

```sh
node apps/desktop/scripts/install-aether-appimage.ts /path/to/Aether-VERSION-linux-x86_64.AppImage
```

Quit Aether before migrating an existing installation. This command also replaces the existing `~/.local/bin/aether`
launcher and `aether.desktop` entry; account data in `~/.config/Aether` is preserved. Start Aether from the application
menu or `~/.local/bin/aether`. Future updates replace `Aether.AppImage` at the same path.

Without a checkout, rename the downloaded file to `Aether.AppImage`, make it executable, and keep it in a writable
folder. Point any shortcuts at that stable path.

## Build from source

Follow the [desktop development guide](desktop-ui.md#launch-the-actual-application) to run from a checkout,
or the [packaging instructions](aether-releases.md#development-build) to create an installer.

## Serve the renderer in a browser

Aether's primary target is the desktop app. If you deploy the renderer from source, build it using the
[renderer instructions](../apps/web/README.md#building-from-source) and serve `apps/web/webapp` as static files.
Copy your configuration to `config.json` and read the [configuration reference](config.md).

Use HTTPS outside localhost. Serve the client on a separate origin from the homeserver, apply the
[security headers](../apps/web/README.md#configuration-best-practices), and follow the
[caching requirements](../apps/web/README.md#caching-requirements).
