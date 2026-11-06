<!-- Copyright 2026 OpenAI
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details. -->

# Windows live-call audio starvation

Measured on 6 November 2026 with installed Aether 0.1.11, Electron 44.9.0, Chromium 152.0.7977.167,
Windows 11 Pro build 26300, and an Intel Core i3-9100F (four cores, four logical processors).
The checkout was `8f9f47da06713d7059bcc98a305efe3403572287`; no production code was changed during capture.

The user reports outgoing voice arriving late or disappearing and incoming voice breaking up when other apps
consume resources, especially Zen and Parsec, and sometimes CS2. They report that Linux and Discord tolerate the
same conditions better. Those platform comparisons have not yet been measured under matched conditions.

## Finding

The running Windows microphone processing path sometimes produces audio more slowly than its input arrives.
The raw microphone track continues delivering samples while the microphone AudioContext and the outgoing WebRTC
source advance more slowly than elapsed time. Incoming WebRTC concealment and RTT spikes were also recorded.

This identifies an outgoing failure boundary between capture delivery and packet generation. It does not yet
identify the Windows scheduler, driver, Chromium behavior, or application behavior responsible for the slowdown.
ANS consumes substantial audio-thread CPU, but bypassing ANS did not eliminate every slow-clock interval.
This report records findings for a subsequent fix; it does not claim the issue is fixed.

## Evidence near the user's cut report

[Sanitized numeric samples](./windows-audio-evidence.json) include consecutive WebRTC snapshots and nearby raw
capture counters. Identifiers, addresses, participant data, conversation content, and raw audio are omitted.
All published timestamps are relative to a reference inside the capture.

Between the snapshots at relative observed times 2987 ms and 4000 ms:

| Measurement                            |                Delta |
| -------------------------------------- | -------------------: |
| WebRTC report timestamps               |           1.012131 s |
| Local observation timestamps           |              1.013 s |
| Outgoing source `totalSamplesDuration` |              0.610 s |
| Outgoing `packetsSent`                 |                   31 |
| Incoming `concealedSamples`            |                 2391 |
| Incoming `silentConcealedSamples`      |                    0 |
| Incoming `concealmentEvents`           |                    1 |
| Incoming `packetsLost`                 |                    0 |
| SFU-reported outgoing `packetsLost`    | No recorded increase |
| Microphone context `underrunEvents`    |          No increase |

Thus approximately 0.402 seconds of expected outgoing source progress is absent from a 1.012-second interval.
The calculation uses the report's own timestamps, rather than assuming that a JavaScript timer fired on time.
The nearby raw-track counters show no increase in `totalFrames - deliveredFrames`; their approximately 500 ms
cadence is separate from the one-second WebRTC snapshots.

The user's report was acknowledged about seven seconds after the concealment event. That timestamp is not an
exact audible onset. The processed source's audio energy did not increase during the selected second, so this
interval demonstrates underproduction of audio samples, not a measured duration of lost intelligible speech.
No conversation audio was recorded for content comparison.

Underproduction also appears when processed-source energy increases: another adjacent pair of snapshots spans
1.950230 seconds of WebRTC time but only 1.720 seconds of source audio, with an audio-energy increase of 0.314603.
That avoids relying solely on the silent-source interval above, while still not identifying particular lost words.

RTP loss counters do not account for every audio failure. In particular, the remote-inbound report describes
reception at the SFU and arrives asynchronously; it does not establish what the other participant heard or rule
out late delivery, downstream loss, or decryption problems. The incoming concealment counter establishes local
replacement audio, rather than an AudioContext speaker-device underrun.

## Longer clock comparison

The microphone input runs at 48 kHz. For the published endpoint pairs, compare raw delivered sample frames divided
by 48000 with both elapsed time and the microphone context's `currentTime`.

| Observed condition            | Elapsed time | Raw input delivered | Context audio advanced |
| ----------------------------- | -----------: | ------------------: | ---------------------: |
| ANS enabled, first interval   |     48.387 s |            48.390 s |               41.147 s |
| ANS bypassed, first interval  |     26.755 s |            26.750 s |               25.960 s |
| ANS enabled, second interval  |     38.503 s |            38.510 s |               36.248 s |
| ANS bypassed, second interval |     38.495 s |            38.500 s |               25.419 s |

The context remained `running`, and the raw track remained enabled and unmuted in these samples. There were no
new microphone context underrun events or raw-track dropped frames in these intervals. Those counters therefore
cannot, by themselves, certify continuous delivery through the complete processing graph.

The ANS comparison changed only the worklet's noise-suppression setting at runtime, using the complete original
configuration and preserving gate, volume, and shortcut state. ANS was restored automatically and verified.
The microphone volume was briefly changed from 100 to 99 and back to obtain the host's complete state message;
its final value was verified as 100. The input profile was not changed.

The normal workload was not held constant: total CPU and participant speech changed between intervals. These
measurements are useful counterexamples to ANS being the sole cause, not a controlled estimate of its effect on
incoming concealment. They also do not distinguish input buffering, discarded samples, or delayed output.

## Audio-thread timing and code path

A separate 60.955-second live-call DevTools trace resolves the microphone callback stack to:

`MicrophoneGateWorklet.process -> denoise -> Denoiser.process -> processFrame -> WASM`.

The first and last second are excluded because starting and stopping the CPU profiler perturbs real-time work.
The excluded shutdown callback lasted 81.118 ms and is not used as steady-state evidence.

| Interior callback measurement                 |    Result |
| --------------------------------------------- | --------: |
| Callbacks examined                            |     21863 |
| Median elapsed                                |  0.038 ms |
| 95th percentile elapsed                       |  4.994 ms |
| 99th percentile elapsed                       |  6.639 ms |
| Callbacks exceeding 10 ms                     |        24 |
| Worst elapsed                                 | 37.359 ms |
| CPU time within that worst callback           |  4.001 ms |
| Remaining elapsed time                        | 33.358 ms |
| Total callback CPU over approximately 58.95 s |  24.165 s |

The remaining elapsed time may be descheduling or waits; this trace does not distinguish them. A 128-sample
render quantum is 2.667 ms at 48 kHz, but exceeding one quantum is not an audible-dropout count: the engine and
driver can buffer audio. The model processes 480-sample frames synchronously, so inference work is concentrated
in larger callbacks rather than spread evenly over render quanta.
CPU sampling can affect timing throughout a recording; these are observations under profiling, not a baseline
latency distribution without diagnostic overhead. The later clock and counter captures ran without that profiler.

Relevant source paths:

- [`MicrophoneGateWorklet.ts`](../apps/web/src/audio/desktop/MicrophoneGateWorklet.ts): runs denoising inside the
  real-time callback. The overload guard measures average denoising wall time per processed second and requires
  three consecutive checks above 70%. It does not measure missing callback cadence or output progress against
  elapsed time.
- [`Denoiser.ts`](../apps/web/src/audio/desktop/denoiser/Denoiser.ts): accumulates input into 480-sample model frames
  and performs synchronous WASM inference.
- [`MicrophoneProcessor.ts`](../apps/web/src/audio/desktop/MicrophoneProcessor.ts) and
  [`PreparedMicrophoneGraph.ts`](../apps/web/src/audio/desktop/PreparedMicrophoneGraph.ts): create a dedicated
  48 kHz AudioContext with interactive latency and send its MediaStream destination track to the call.

The installed WASM SHA-256 was
`34f8dcc64d092f62d20f777ac9873f521b7bbd2486940657dc868f5b3c93719e`, matching the optimized SIMD binary in the checkout.
An accidentally installed older scalar denoiser is ruled out for this capture.

## Negative tests and unresolved causes

- A bounded 20-second normal-priority CPU load reached approximately 100% system CPU without increasing the
  microphone underrun, media-playout synthesis, or incoming concealment counters. Speech activity was low.
  Total CPU percentage alone is not a sufficient reproducer.
- A separate 90-second test briefly connected an inaudible constant source to the microphone context's local
  speaker destination, without connecting it to the transmitted track. The audio clock ran at real-time speed
  before, during, and after that intervention. The source was stopped and disconnected. This did not reproduce
  or validate a silent-output clock hypothesis.
- A repeated mixed-workload capture measured per-core DPC activity, including a 24.54% half-second sample on core 0. This is aggregate CPU time, not an individual DPC duration or interrupt-to-thread latency measurement. It
  cannot identify a driver or prove a DPC caused a specific cut. Parsec and Zen GPU activity was also present.
- Native snapshots found the renderer's AudioWorklet thread at priority 15. A later snapshot reported no explicit
  execution-speed throttling on that renderer or worklet. These snapshots do not establish their scheduling
  state during the cut.
- A later 120-second minimize/restore capture recorded matching raw/context clocks and document visibility.
  After discarding three seconds at each visibility transition, a hidden interval delivered 40.990 seconds of
  raw input and advanced the context 40.643 seconds over 41.004 seconds of elapsed time. A visible interval
  delivered 30.380 seconds of input and advanced the context 28.869 seconds over 30.380 seconds. Both remained
  `running`, with no new raw drops or microphone underruns. Minimization alone did not reproduce the severe
  one-third slowdown; this does not rule out interactions with a particular workload or occlusion state.
- Decryption-key errors were observed separately in the console. Their timing was not correlated with the
  reported cuts, so they cannot yet explain the CPU-related symptom.
- Windows Performance Recorder could not start CPU/Audio profiling: `0xc5585011`, failure to enable system
  performance profiling policy. No kernel scheduling or driver-duration trace was obtained.

## Next discriminating capture

1. Reproduce a slow microphone clock while collecting raw delivery, context progress, output source progress,
   document visibility, and callback timing together. Keep real voice active and record the exact cut marker.
2. Enable Chromium's `disabled-by-default-mediastream`, `audio`, `disabled-by-default-audio`, and `webaudio`
   trace categories without CPU sampling or heap queries during the measurement. Check for input FIFO overflow,
   device callback gaps, and real-versus-software output-clock transitions.
3. Repeat the same workload and visibility state with ANS enabled and bypassed. Compare sample production and
   incoming concealment, not only CPU averages. Restore the complete original state after each comparison.
4. Use a Windows scheduling/DPC trace, when profiling privileges are available, to distinguish thread starvation
   from blocking and attribute any driver delay. A process-priority or driver change is not justified by the
   current aggregate measurements alone.

The pinned Chromium input bridge has a bounded FIFO and explicitly drops an arriving block when that FIFO is
full. That is a source-supported mechanism for a slow WebAudio consumer to lose already-captured microphone
audio, but a FIFO-full event has not yet been captured here.

References: [Chromium 152 input bridge](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/modules/mediastream/webaudio_media_stream_audio_sink.cc),
[WebRTC statistics definitions](https://www.w3.org/TR/webrtc-stats/),
[media capture statistics](https://w3c.github.io/mediacapture-extensions/#the-mediastreamtrackaudiostats-interface),
[Microsoft audio-glitch analysis](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/optimizing-windows-devices-for-multimedia-experiences-exercise-4).

## Validation and retained artifacts

The sanitized samples can be independently differenced to reproduce the selected event and clock table. The
callback summaries were derived from the original trace, with profiler boundaries excluded. An independent
review checked the report timestamps, counter differences, and interpretation limits.

The original trace, full counter logs, native CPU/DPC/GPU captures, and analysis scripts remain local. The trace
contains screenshots and application data and is intentionally not part of this public report. No production
behavior, translations, or screenshot baselines change in this documentation PR.
