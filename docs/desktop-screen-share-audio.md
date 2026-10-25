<!-- Copyright 2026 Gabriel. SPDX-License-Identifier: AGPL-3.0-only -->

# Desktop screen-share audio backend

This backend adds explicit playback capture to a desktop screen share. It does not change the screen-share picker or
enable audio automatically. The separate call UI change can offer the capabilities and application choices below.
Capture never opens the microphone or replaces the user's recording device.

| Environment                                                  | System playback                                                | Selected window/application                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Windows x64, build 20348 or later, packaged helper present   | Process loopback excluding Aether and its children             | Playback from the selected application's process tree                                               |
| Linux with PulseAudio or PipeWire-Pulse, `pactl` and `parec` | Mix of eligible application playback streams, excluding Aether | Selected process and its children; X11/XWayland window association where `_NET_WM_PID` is available |
| Native Wayland windows                                       | Same Linux playback backend                                    | Explicit application selection; an opaque portal source is never guessed to identify an application |
| Other environments                                           | Reported unavailable                                           | Reported unavailable                                                                                |

A window's audio means its application's playback. Applications that share one process tree across several windows
can share audio from those other windows too. The Windows version requirement comes from Microsoft's
[process loopback API](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

The Linux path monitors individual Pulse playback streams without moving them to another sink or changing the default
speaker/microphone. Pure PipeWire/JACK clients that are not visible through the Pulse server are outside this capture
path. Streams whose process ownership cannot be established are excluded. This is deliberately stricter than capturing
an entire sink and accidentally feeding call playback back to other members.

## Integration

The context-isolated preload exposes `window.electron.screenShareAudio`, whose contract lives in
`packages/shared-types/lib/screenshare-audio.d.ts`:

- `capabilities()` reports actual availability, including missing utilities, unsupported Windows versions, or a missing helper.
- `applications()` lists native audio targets. Treat their IDs as opaque and refresh them before presenting a choice.
- `start()` requires an explicit target and the source ID from a recent successful desktop video picker selection.
- `stop()` releases native capture. `onEvent()` delivers bounded PCM packets and terminal events.

The API accepts calls only from the main application's top-level frame. A video selection authorizes one audio startup
within thirty seconds. Cancelling/replacing a selection, navigation, renderer failure, hangup, or shutdown revokes it.
Window resolution failure returns an error; it never falls back to system playback.

Call code should use `captureScreenShareAudio` in `apps/web/src/audio/desktop/ScreenShareAudio.ts` with the approved video
stream, selected source ID, and one of `{ kind: "system" }`, `{ kind: "window" }`, or
`{ kind: "application", id }`. It returns the combined stream and an idempotent audio cleanup action. Pass an abort signal
while starting a share, and retain the cleanup action for the call's teardown. Existing browser-provided display audio
is preserved without starting a second playback capture.

PCM is stereo float32 little-endian at 48 kHz. Native IPC packets contain at most 20 ms, with at most eight unacknowledged
packets. The audio adapter uses a worklet and a bounded audio queue. It does not route captured playback to the local
speakers, apply microphone noise suppression, or change participant microphone volume.

## Building and dependencies

Windows builds require Visual Studio C++ Build Tools and a Windows SDK containing `audioclientactivationparams.h`.
Run this from `apps/desktop` before packaging:

```sh
node scripts/build-share-audio-windows.ts --arch=x64
```

Both desktop package configurations include the generated standalone helper outside the app archive, at
`resources/share-audio/aether-share-audio.exe`. Packaging fails if it is missing. The helper is independent of the
Electron Node ABI. The desktop build workflow compiles it, and the validation workflow builds and checks its capability
protocol on Windows.

Linux needs `pactl` and `parec` from the distribution's PulseAudio utilities, plus a reachable PulseAudio or PipeWire-Pulse
server. X11 window association also needs `xprop`. The Aether Debian package recommends `pulseaudio-utils` and `x11-utils`.
AppImage/tar users must provide these utilities themselves. Missing support is reported through `capabilities()`.

## Verification

Run desktop backend tests from `apps/desktop` with `pnpm exec vitest run`, and renderer transport tests from the repository
root with `pnpm exec vitest run --project unit apps/web/src/audio/desktop/ScreenShareAudio`. Tests cover selection grants,
IPC ownership, process isolation, exclusions, PCM ordering, bounded buffers, cancellation during startup, and teardown.

After compiling the desktop sources with `pnpm --dir apps/desktop exec tsc`, the Linux provider smoke can run with
`node apps/desktop/scripts/smoke-share-audio-linux.ts`. It creates a temporary null output, plays two synthetic tones,
captures one application through the actual provider/mixer, checks that the other tone is absent, and verifies resource
cleanup and the original default output. Its optional `--system` mode requires an explicit `PULSE_SERVER`; CI runs that
mode against a private PulseAudio daemon containing only synthetic playback.

On Windows, compile the helper and run `node apps/desktop/scripts/smoke-share-audio-windows.ts` to check native capability
and window validation, capture readiness, optional PCM framing, and clean shutdown. This startup/shutdown check needs
the Windows audio services but does not require a physical playback device or establish audible quality. The renderer
worklet can also be checked in Chromium with synthetic stereo PCM using the emitted production asset.

For a release, additionally verify on real Windows and Linux machines:

1. Play distinct audio in two applications. System capture should contain both; application capture should contain only
   the selected application and its children. Repeat with an application that has several windows.
2. Receive call audio while sharing. It must remain audible locally and absent from the outgoing share's playback track.
3. Change output devices, open/close playback streams, and stop the selected application. Check for stuck capture helpers
   and correct termination or silence; do not accept a switch to unrelated application audio.
4. Cancel while capture is starting, stop the video track, hang up, reload the renderer, and quit. All capture resources
   must close. Confirm the ordinary microphone and default sound routes remain unchanged.

Unit tests and Windows compilation do not establish audible quality or hardware/driver compatibility. Keep runtime
capture evidence separate from those checks.
