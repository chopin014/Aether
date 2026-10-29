<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Aether desktop releases

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
mkdir -p apps/desktop/webapp
cp -a apps/web/webapp/. apps/desktop/webapp/
pnpm --dir apps/desktop exec tsc
pnpm --dir apps/desktop exec node scripts/copy-res.ts
pnpm --dir apps/desktop run asar-webapp
pnpm --dir apps/desktop run build:aether --linux --x64
# On Windows, use --win --x64 instead of --linux --x64.
```

`build:aether` uses `--publish never`: the build does not upload anything, while its explicit public GitHub provider
still embeds the update feed and creates local update metadata. `VERSION` overrides the package version for local
builds; otherwise `apps/desktop/package.json` supplies it. The renderer config deliberately has no Element update
feed, telemetry, or crash upload endpoint.

## Prepare a release

Push a new semantic version tag to build all release artifacts and prepare a draft:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The tag determines the package version. Tags may include a semantic version prerelease identifier, such as
`v0.2.0-rc.1`. The [Aether desktop workflow](https://github.com/chopin014/Aether/actions/workflows/aether-desktop.yaml)
runs desktop typechecks and unit tests, builds the renderer, then packages Linux and Windows x64 installers. It checks
the installers, update metadata, and each metadata SHA-512 checksum before uploading anything to a GitHub release.
Only after both platform builds and the final combined asset check pass does it create or update a draft release.

You can also run **Aether desktop builds** from the Actions page. Leave the version blank to use the version in
`apps/desktop/package.json`, or enter a semantic version to package a different version. Manual runs upload workflow
artifacts by default. Select **Create a draft GitHub release** from **main** to create a draft after the same checks
pass. Release tags must point to a commit on main. A manual draft targets the selected main commit and uses the
corresponding `v<version>` tag. Use a new version when making a release; `v0.1.0-dev.1` was already published.

## Review and publish

Open the draft at [Aether Releases](https://github.com/chopin014/Aether/releases) and review the title, generated
notes, prerelease setting, and assets. A prerelease version is marked as a GitHub prerelease automatically. Publish the
draft when it is ready. Drafts are not visible to the updater; users receive a release only after it is published.

Keep all uploaded installer files, Windows `.blockmap` files, and `latest.yml` / `latest-linux.yml` metadata attached
to the release. The workflow checks that the metadata version matches the package, that it references the expected
NSIS installer or AppImage, and that each `files[].sha512` checksum matches its installer. Do not hand-edit the
generated metadata or remove assets that it references. Linux packages are AppImage, Debian `.deb`, and `.tar.gz`.

## Update behavior and platform support

Stable and prerelease builds embed the public `latest` feed for `chopin014/Aether`. GitHub marks prerelease releases
separately, while the desktop updater checks stable releases only. Prerelease builds are for manual download and
testing; they do not opt users into preview updates. Stable releases publish `latest.yml` for Windows and
`latest-linux.yml` for Linux. Linux automatic updates are supported for the AppImage build. The `.deb` and `.tar.gz`
files are manual installation formats and are not updated by the app.

The first updater-enabled build must be installed manually by users who already have an older Aether build. After that
one upgrade, the app can find published stable releases through GitHub. Windows installers install per-user to avoid
administrator prompts during updates. Windows builds are intentionally unsigned because Aether has no signing
identity configured. Windows may show its standard publisher or SmartScreen warning when downloading or running an
installer.

The Windows packaging job silently installs the built NSIS installer, checks the installed app version and update
configuration, opens the app window, then runs the same installer again and verifies that an isolated user-profile
marker survives and the app opens again. This checks the per-user install and reinstall path. It does not exercise
electron-updater downloading and applying a different version or verify interactive sign-in.

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

## Validation performed

The Linux x64 application was packaged with its own executable, app ID, protocol, icons and embedded renderer.
The packaged native smoke test signs in to a disposable Matrix server, creates a Space and text/voice rooms,
sends and receives real messages, opens the member list and checks settings at the reference viewport.
Playwright runs against a separate copy with its inspection fuse enabled; the distribution copy retains its
production fuse settings. The Windows x64 NSIS installer is intentionally unsigned. For `0.1.0-dev.1`, the
[desktop workflow](https://github.com/chopin014/Aether/actions/runs/39852786892) passed its renderer, Windows installer
and Linux AppImage/deb/tar.gz jobs. The packaged native smoke test passed in 33.3 seconds, and the legacy-key audio
regression passed in 50.3 seconds after failing against the previous renderer with zero decoded audio energy.
Interactive Windows installation and update runtime testing are still pending.

The two-person MatrixRTC test verifies audio transport, microphone/deafen controls, call continuity while
reading a text room, live sidebar members, and participant visibility while the local user is disconnected.
Unit tests cover sound preferences/output routing, rejected controls, membership changes, profiles and cleanup.
The landing page publishes only `site/` to `gh-pages`; research captures remain outside the public repository.
Inherited upstream automation is disabled on the Aether repository. Aether release builds run for `v<semver>` tag
pushes, and manual workflow runs remain available for test builds and reviewed drafts.

## Existing Element Call clients

The pinned SDK's strict membership-ID matching discarded valid media keys from existing Element Call clients.
Those clients send a per-join UUID in encrypted key messages while publishing a legacy `user:device` membership ID.
This caused one-way audio: incoming RTP packets increased, but no audio samples decoded.

`patches/matrix-js-sdk@44.0.0.patch` permits that mismatch only for the same user and device with exactly one
backend identity equal to its legacy membership ID. Modern and mixed backends still require exact session IDs.
Encrypted key transport, key rotation, membership gating and encryption remain enabled. No keys are logged or exported.
Regression tests cover different users/devices, modern IDs, rotation and keys arriving before membership.
The two-client voice test reproduces the legacy UUID format and checks nonzero decoded audio energy and live playback,
including after undeafening, rather than relying on incoming packet counts alone.

On the local Arch Linux machine Aether is installed per-user under `~/.local/opt/aether`, with an application-menu
entry and an `aether://` handler. It does not require a Debian package or administrator privileges.
