# Aether packaging assets

`icon.svg` is the app icon: `logo/aether-simbolo-compacto-positivo.svg` from the Aether identity package, unchanged,
on a Vácuo (`#090A12`) tile. The brand manual uses the compact symbol for app icons and favicons.
`icon.png` (512 px) and `icon.ico` (16–256 px) are rendered from it; regenerate both whenever the SVG changes.
Never redraw the symbol; take new versions from the identity package.

Aether uses its own application ID, user data directory, URL protocol, installer name and homepage.
Automatic updates are disabled until Aether has its own tested update service and signing setup.
Do not use Element update URLs, telemetry endpoints or release workflows for Aether releases.
