<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Screenshare audio verification

## Reported failure

Aether 0.1.5 on Windows 11 shared Zen or the whole screen to an Aether 0.1.5 client on Arch Linux.
Video and microphone audio worked; shared program audio was silent with Share audio enabled.
The media was ordinary, unprotected content.

The exact original Windows-to-Arch failure is not yet reproduced. Do not equate the confirmed bugs below with
proof of that original failure's cause. The user has offered to repeat the cross-platform call with a test build.

## Confirmed defects

1. Enabling audio on an existing video-only share updated the confirmed preference without acquiring any audio
   track. A regression fails against the released helper and passes with capture reacquisition.
2. A late failure or dismissal from a superseded picker could reset the requested state of a newer share.
   Both cancellation and source-error regressions failed before ticket ownership was enforced.
3. Review caught broad cancellation filtering in the new reselection path. Dedicated cancellation markers
   retain cancellation behavior while allowing publication failures to reach the interface.
4. A generated dependency chunk filename made the Element Call patch fail on a clean Windows installation.
   The helper import now uses an insertion hunk without platform-specific generated context.

The final source-picker preference is returned to the host before settings are persisted. Requested audio missing
from capture now fails explicitly instead of confirming a silent share.

## Baseline and local checks

| Check                                         | Result and limits                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed release                             | Both installed application archives identify as 0.1.5; the release contains PR #28.                                                                                                                                                |
| Shipped Windows native backend                | Produces nonzero 48 kHz stereo PCM. A headless isolated Zen profile produces the known 440 Hz tone in both system and process capture.                                                                                             |
| Released renderer bridge                      | Production picker, preload, and renderer return a live audio track containing the source tone when final consent is enabled. This is not a MatrixRTC call.                                                                         |
| Desktop unit suite                            | 332 passed, 2 existing skips on Windows. Two path assertions were made portable.                                                                                                                                                   |
| Broad audio/call unit suite                   | 522 passed; one unchanged speech test exceeded its deadline. Its repeated full-recording level calculation was cached; the seven real-model denoiser tests then passed.                                                            |
| Publication helper regressions                | 26 passed after capture, consent, policy, failure, cancellation, and concurrency fixes.                                                                                                                                            |
| View-model regressions and coverage           | 23 passed; all 6 changed executable view-model lines covered by LCOV.                                                                                                                                                              |
| Windows native/picker/WebRTC matrix           | 7 passed without retries: native screen/window capture, host exclusion, restart/shutdown, and window/screen picker to decoded WebRTC audio with both consent states. Uses the released 0.1.5 renderer locally.                     |
| Current-source Linux encrypted call journey   | 5 Linux native cases passed initially and 1 passed on retry, with 1 Windows-only skip; all 8 encrypted-call journeys passed initially. A stricter repeat run is pending. OS capture is synthetic only in the encrypted-call suite. |
| Packaged test builds and Windows-to-Arch call | Windows/Linux packaging and Windows install/reinstall smoke tests passed. All 4 Windows packaged-resource capture cases passed using an instrumented executable copy. Manual call pending.                                         |

## Harness findings

- A 30-second budget for two Electron startups, capture, and shutdown can expire during successful cleanup on this
  Windows machine. A later bounded shutdown test also passed with the original native backend. No speculative
  native COM cleanup change is included.
- The Linux native journey needs a window manager as well as Xvfb to enumerate application windows.
- The encrypted-call journey waited for a WASM request after the cached module had already loaded, and used a
  timeline test ID stripped by production compilation. Its assertions now observe requests from the start and use
  accessible timeline structure.
- Test tones retain their windows and audio graphs, change video frames, and verify source, captured, and decoded
  tone separately. Audio-off cases must decode video without an audio receiver.

## Reproduction and evidence

The baseline CI run is [41687840590](https://github.com/chopin014/Aether/actions/runs/41687840590): lint, desktop/audio
unit tests, and updates journey passed. The expanded native/encrypted journey failed and retained trace artifacts;
those failures drove the harness corrections above. The corrected green run is linked below; the exact manual cross-platform call remains pending.

An isolated Electron peer probe decoded a 440 Hz tone while reporting totalAudioEnergy as zero. The native journey now checks decoded sample counts, PCM energy and the known tone directly. Source documents and OS window enumeration are awaited before capture. The live-enable checkbox journey waits for asynchronous publication confirmation.

Run [41709447038](https://github.com/chopin014/Aether/actions/runs/41709447038) passed lint, unit and updates checks; the call journey passed 7 of 8 tests and exposed the asynchronous checkbox assertion. The corrected journeys passed in [41711605340](https://github.com/chopin014/Aether/actions/runs/41711605340).

The packaged artifact is version 0.1.6-audio.1 from [41709446420](https://github.com/chopin014/Aether/actions/runs/41709446420). Its archives contain both the missing-audio guard and cancellation marker. The unchanged production executable disables Node CLI inspection, so Playwright cannot attach to it. Only a separate Aether-Instrumented.exe copy enabled that fuse for the four automated package cases; packaged resources and native modules were unchanged. The original Aether.exe remains unchanged for manual testing.

The Linux full-screen FFT reading needed one retry because default spectral smoothing attenuates initial measurements (the isolated probe measured about -67.5 dB for an injected 0.01-amplitude tone). All analysers now disable smoothing; the four Windows renderer cases pass with that calibration. CI now repeats native cases twice with retries disabled, and encrypted calls also disable retries. This stricter run is pending.

No Docker or WSL runtime is installed on this Windows host. The container-backed homeserver and encrypted-call
journey therefore run in GitHub Actions. No release is published or merged by this work.
