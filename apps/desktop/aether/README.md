# Aether packaging assets

`icon.svg` is the app icon: `logo/aether-simbolo-compacto-positivo.svg` from the Aether identity package, unchanged,
on a Vácuo (`#090A12`) tile. The brand manual uses the compact symbol for app icons and favicons.
`icon.png` (512 px) and `icon.ico` (16–256 px) are rendered from it; regenerate both whenever the SVG changes.
Never redraw the symbol; take new versions from the identity package.

Aether uses its own application ID, user data directory, URL protocol, installer name and homepage.
Desktop updates use the public GitHub Releases feed for `chopin014/Aether`; no release token is included in the app.
Stable releases are offered by the updater. Prerelease builds are available for manual download and testing.
Windows installers are unsigned and install per-user so updates do not require administrator prompts. See
[the Aether release guide](../../../docs/aether-releases.md) for the tag, draft review, publishing, and first-install
steps.
Use Aether's own update feed and release workflow. The desktop configuration does not enable telemetry or crash uploads.
