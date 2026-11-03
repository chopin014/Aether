<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Screenshare audio implementation plan

> Execute inline using the executing-plans skill. Use test-driven-development for each confirmed regression.

**Goal:** Restore Windows desktop stream audio and prove the sender-to-receiver behavior described in the approved spec.

**Architecture:** Retain native process capture. Verify the real preload, renderer stream, call publication, and
receiver playback before changing the failing layer. Extend existing tests and retain artifacts for platform runs.

**Tech stack:** Electron, WASAPI, PulseAudio/PipeWire, Web Audio, LiveKit/MatrixRTC, Vitest, Playwright, GitHub Actions.

## 1. Establish the released baseline

- [x] Verify v0.1.5 includes PR #28 and compare the installed application's metadata and native module.
- [x] Run desktop audio and callback unit tests from apps/desktop: 14 tests passed.
- [x] Exercise the packaged Windows native module: nonzero 48 kHz stereo PCM received.
- [x] Record source types and consent from the user's reproduction: both window and screen fail with audio enabled.
- [x] Isolate work from the dirty original checkout in codex/screenshare-audio.
- [ ] Run the existing native screen/window integration tests using a development Electron executable and the
      production desktop-audio module. Measure target tone and host exclusion.
- [ ] Run an integration probe through production preload and renderer capture, then a real WebRTC receiver.
      Record track state, received energy, and the first failing boundary.

## 2. Restore reproducible installation

Files: patches/@element-hq__element-call-component.patch, pnpm-lock.yaml, and a focused patch validation test if needed.

- [ ] Reproduce the clean Windows pnpm install failure and compare the generated bundle with patch context.
- [ ] Remove generated chunk-name context from the import hunk if that is the only mismatch; verify every remaining
      hunk against a fresh dependency tree. Do not weaken functional assertions.
- [ ] Reinstall with the pinned pnpm 12.14.0 binary and --frozen-lockfile after regenerating the patch hash.
- [ ] Re-run desktop compilation and the audio tests on the completed installation.

## 3. Fix each demonstrated runtime failure

Primary boundaries: apps/desktop/src/desktop-audio.ts, apps/desktop/src/preload.cts,
apps/web/src/audio/desktop/DesktopAudioCapture.ts, apps/web/src/vector/platform/ElectronPlatform.tsx,
patches/@element-hq__element-call-component.patch, and their existing tests.

- [ ] Add a regression assertion at the boundary identified by task 1 and run it against unchanged production code.
- [ ] Record the expected failing assertion before implementing the smallest fix at that boundary.
- [ ] Verify native audio becomes a live track and the receiver decodes the known external tone.
- [ ] Repeat for consent changed in the picker, audio off, cancellation, and error handling.
- [ ] Verify stop, renderer exit, late packets, repeat starts, and source replacement release capture and audio graphs.
- [ ] Verify microphone mute/PTT independence and remote stream mute, volume, deafen, and output controls.
- [ ] Keep quality policy enforcement tests passing for capture and sender encodings.

## 4. Make end-to-end coverage repeatable

Files: apps/desktop/playwright/e2e/sharing/native-audio.spec.ts and related sharing specs,
apps/web/playwright/e2e/desktop/element-call-voice.spec.ts, .github/workflows/aether-validation.yaml,
and focused fixtures needed by those suites.

- [ ] Extend native coverage through preload, the renderer track, and remote WebRTC decoding using separate apps.
- [ ] Extend the MatrixRTC call journey to cover audio consent chosen after capture begins and actual stream energy.
- [ ] Run Windows tests locally with audio output available; retain test reports and capture diagnostics.
- [ ] Run Linux integration and container-backed MatrixRTC tests in CI with audio services enabled.
- [ ] Exercise packaged builds where practical and distinguish synthetic OS capture from native capture in results.

## 5. Verify and deliver

- [ ] Run relevant desktop/renderer/component unit and browser suites and changed-file coverage (target at least 80%).
- [ ] Run affected workspace typechecks, oxfmt, oxlint, and pnpm i18n if translated strings change.
- [ ] Review the final diff for unrelated changes, swallowed errors, leaked resources, and unsupported success claims.
- [ ] Obtain code review, fix actionable findings, and rerun checks affected by those fixes.
- [ ] Commit focused changes, push codex/screenshare-audio, and open the requested PR against main.
- [ ] Report demonstrated root cause, verification evidence, CI status, and any remaining platform test limitations.
