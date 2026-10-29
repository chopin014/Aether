# Native Node Modules

For some features, the desktop version of Aether can make use of native Node
modules. These allow Aether to integrate with the desktop in ways that a browser
cannot.

Currently the only native module is [Seshat](https://github.com/matrix-org/seshat),
which adds support for local event indexing and full text search in E2E encrypted rooms.

## Prebuilt binaries

Seshat is consumed via the [`@matrix-org/seshat`](https://www.npmjs.com/package/@matrix-org/seshat)
npm package, which ships prebuilt binaries for every platform Aether desktop supports as
per-platform `optionalDependencies`:

| Platform | Architectures | SQLCipher |
| -------- | ------------- | --------- |
| Linux    | x64, arm64    | static    |
| macOS    | x64, arm64    | static    |
| Windows  | x64, arm64    | static    |

pnpm only installs the binary matching the machine running the install. Building for
another architecture (for example a Windows arm64 package on an x64 machine, or the macOS
universal package) needs pnpm to install the extra binaries too. This is done by adding a
[`supportedArchitectures`](https://pnpm.io/settings#supportedarchitectures) block to
`pnpm-workspace.yaml` before running `pnpm install`, for example for a macOS universal build:

```yaml
supportedArchitectures:
    os: [current] # Assuming you are on "darwin"
    cpu: [x64, arm64]
```

Cross-platform custom builds must install the matching binaries before packaging. The electron-builder configuration prunes binaries
for other platforms and architectures from the packaged app, so only the ones needed by the
target end up in the package.

## Verifying a Linux package

For a custom Linux package, use `apps/desktop/scripts/glibc-check.sh` to inspect packaged `.node` files.
See [Aether releases](aether-releases.md) for the actual release targets and packaging checks.

## Building from source

Should you need to build Seshat yourself, for example for an unsupported platform or to
link against the system SQLCipher, follow the instructions in the
[Seshat repository](https://github.com/matrix-org/seshat/tree/main/seshat-node#building-from-source)
and use `pnpm link` to substitute the resulting package for `@matrix-org/seshat`.
