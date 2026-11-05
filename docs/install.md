# Installing Aether

Download Aether builds from [GitHub Releases](https://github.com/chopin014/Aether/releases).
The release targets are Linux x64 AppImage and Windows x64 installer.
See the [release guide](aether-releases.md#update-behavior-and-platform-support) for platform limitations,
first installation, and automatic updates.

A Matrix account is required. Voice channels also need a homeserver with MatrixRTC calling services configured;
installing the client does not install a homeserver or calling services.

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
