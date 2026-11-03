<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Screenshare audio reliability and Windows parity

## Outcome

Repair desktop screenshare audio in the code shipped as Aether 0.1.5. Windows users must be able to share an
application's audio or desktop audio, hear other participants normally, and control received stream audio separately
from microphones. Preserve Linux support. Deliver the changes in a new pull request with recorded test evidence.

“Discord parity” refers to screensharing and its audio controls in this work. It does not expand the task to other
Discord features. Audio must remain an explicit choice in the picker.

## Evidence before implementation

- Release v0.1.5 points to 6230ad10fe and includes PR #28, which introduced native desktop audio capture.
- The user reproduced silent audio with both application-window and full-screen sharing, with Share audio enabled.
  Video worked in both cases.
- The installed Windows application identifies itself as version 0.1.5. Its packaged native capture module loads
  and produces nonzero 48 kHz stereo float32 PCM on this PC when exercised directly. This is a backend diagnostic,
  not proof that the application publishes or plays stream audio.
- The existing native test observes PCM before renderer delivery. It does not exercise the renderer bridge,
  stream construction, call publication, encryption, receiver decoding, or playback.
- The original PR records Linux native tests and explicitly says Windows runtime capture was not verified.
- The original checkout contains unrelated uncommitted changes. Work is isolated on codex/screenshare-audio in
  a sibling worktree based on current origin/main, which matches v0.1.5.

## Approach

Keep the existing native process capture and repair the first failing boundary demonstrated by a regression test.
Trace source confirmation, native PCM, preload delivery, renderer audio track construction, LiveKit publication,
receiver decoding, and playback independently. Avoid replacing working layers without evidence.

Electron's built-in system loopback is an alternative for desktop audio, but its public capture handler does not
provide arbitrary external-window audio isolation. Replacing the native backend would increase scope without
addressing a demonstrated cause. Retaining the native bridge supports the intended source isolation on both OSes.

## Required behavior and acceptance tests

| Area               | Required evidence                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Full-screen audio  | External application's known tone reaches the receiver; Aether's own playback is excluded.                  |
| Application audio  | Selected application's tone reaches the receiver; another application's tone is excluded.                   |
| Consent            | Audio off produces video without captured audio; cancel produces neither capture nor publication.           |
| Picker changes     | The final audio preference applies even when changed while display capture is pending.                      |
| Voice independence | Microphone mute and push to talk do not suppress shared program audio.                                      |
| Playback           | Stream mute and volume affect stream audio independently of the participant's microphone.                   |
| Global output      | Deafen, speaker volume, and selected output device apply consistently to received audio.                    |
| Lifecycle          | Stop, OS-ended capture, leave, renderer teardown, repeated start/stop, and failed starts release resources. |
| Quality            | Resolution, FPS, and bitrate limits still apply before and after publication.                               |
| Failure visibility | Requested audio cannot silently be reported as successful when its capture path fails.                      |
| Transport          | Tests measure decoded audio energy or the expected tone, not merely track counts or received bytes.         |
| Release            | Verify packaged native modules and the renderer integration used by the shipped app.                        |

For source changes, test stopping the old share and starting the newly selected source. Any direct source-switch
capability found necessary during the audit must retain the same consent, isolation, and cleanup guarantees.

## Test layers

1. Unit regressions at each demonstrated faulty boundary, extending existing Vitest files where possible.
2. A Windows native integration run using separate sound-producing applications and the production capture module.
3. A renderer integration run through the real preload and production audio bridge, verifying the generated track
   across a real WebRTC connection with a receiver-side audio measurement.
4. A real MatrixRTC/LiveKit call journey that verifies stream publication, encryption, remote playback, controls,
   and cleanup. Existing synthetic-capture tests remain useful but are labelled as such.
5. Linux native integration and call journeys in a suitable audio-enabled environment, with CI artifacts retained.
6. Relevant typechecks, formatting, lint, unit coverage, and desktop packaging checks.

Record each result as passed, failed, or not executed with the specific reason. A green mocked test or skipped
platform case is not evidence of hardware behavior. There is no container runtime or installed WSL distribution
on this Windows PC at investigation start; use available CI for Linux and container-backed tests, and identify any
remaining infrastructure requirement precisely.

## Delivery

Keep implementation changes focused, preserve unrelated local work, and open the requested PR after local
verification. The PR must state the demonstrated root cause, behavior changed, actual commands/results, and any
unverified platform cases. Do not merge or publish a new release as part of this request.
