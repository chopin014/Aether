# Aether desktop builds

Aether's initial targets are Linux x64 (AppImage, deb, tar.gz) and Windows x64 (NSIS installer).
The source remains the Element monorepo; `element-desktop` and `element-web` are internal workspace names.
The app ID is `io.github.chopin014.aether`, executable `aether`, and callback protocol `aether://`.
These identities isolate Aether from installed Element clients. Package versions are independent of upstream.

## Development build

Build shared-components and the production renderer, copy `apps/desktop/config.desktop.json` to
`apps/web/webapp/config.json`, then archive the renderer and build the native application:

```sh
pnpm --filter @element-hq/web-shared-components build
pnpm exec nx run element-web:build
cp apps/desktop/config.desktop.json apps/web/webapp/config.json
pnpm --dir apps/desktop exec tsc
pnpm --dir apps/desktop exec node scripts/copy-res.ts
pnpm --dir apps/desktop run asar-webapp
pnpm --dir apps/desktop run build:aether --linux --x64
# On Windows, use --win --x64 instead of --linux --x64.
```

Use the Aether desktop workflow for reproducible platform builds. It creates artifacts without publishing a release.
Set `VERSION` to a valid Aether semver before release; the development default is `0.1.0-dev`.
`--publish never` and `publish: null` prevent accidental uploads. The renderer config deliberately has no Element update feed,
telemetry, or crash upload endpoint. The final icon/colors, Windows signing, Aether update delivery, installed-package
smoke tests and UI completion are required before announcing a production release.

## Voice feedback

Original Aether two-note WAV cues are generated with `node apps/web/scripts/generate-aether-sounds.ts`.
The frequencies and envelope are source-controlled; no Discord sound recordings are bundled.
Mute/unmute and deafen/undeafen cues play after successful controls, and join/leave follow real connection changes.
Sounds use the selected audio output, have a device setting under Voice → Sounds, and do not block transport actions.

## Voice participants

The channel list uses `CallStore`/Element Call's MatrixRTC participant map, even when the local user has not joined.
Each user appears once across multiple devices. Membership and profile updates refresh the rows, which open real Matrix profiles.
MatrixRTC room state does not expose remote users' speaking/microphone state to non-participants; those indicators must only be
added when an authoritative media signal is available. Do not fabricate speaking rings or mute badges.
