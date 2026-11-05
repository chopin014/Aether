<!-- Copyright 2026 Gabriel
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details. -->

# Noise suppression and speech loss

Investigated 2026-11-05 against base `cbc3f637a069da20f034bad649d6aa8b0d22500f`, comparing the complete Aether
microphone pipeline (DeepFilterNet3 WASM, output high-pass, voice-informed gate) with Krisp `full_NC` running
unmodified inside Discord 1.0.168. Both receive identical float32 input; outputs are aligned per sample.

## Summary

1. **Runtime decisions, not the network, cut most speech.** The native runtime hard-muted frames whose SNR estimate
   fell below −10 dB and bypassed the learned output above 20/30 dB. Thresholds are now (−15, 35, 35), so both
   decoders run on every frame.
2. **The gate's speech detector was an SNR estimate.** It flagged pink noise and babble as speech on about 90% of
   frames, read silence as +4 dB, and recognised words late under loud noise. The encoder's `lsnr` head was
   reprogrammed in weight space into a speech detector (`apps/web/native/aether-denoiser/model/README.md`). No
   denoising weight changed.
3. **On real noise recordings Aether now beats Krisp** on PESQ, ESTOI, speech retention and cut speech at every SNR
   from −10 dB to clean. Krisp still removes more noise during speech at −10 dB on strongly low-frequency noise and
   keeps pauses quieter.

## Benchmarks

All mixtures have separate clean and noise tracks, 12 s each: noise throughout, speech at 2–6 s and 7.5–11.5 s,
SNR −10 to +20 dB plus clean-only and noise-only items.

- **Edinburgh** (VCTK speech, real 48 kHz noise recordings). The noise is recovered as noisy − clean after undoing
  the corpus's clipping-avoidance gain (residual speech correlation below 0.024). The `etest` split uses a speaker
  and noise recordings never used for fitting or choosing.
- **0x3** (Hugging Face `0x3/speech-noise-dataset`, resampled from its real 44.1 kHz). Its speech is band-limited to
  about 8 kHz and most of its noise is low-frequency rumble, so it is only a secondary benchmark. Synthetic white,
  pink and five-talker babble noise were added.

An offline Python copy of the native runtime and the gate matches the native library and the TypeScript/WASM
pipeline within 1e-6, which allowed quick evaluation of every candidate. Final numbers were checked against the
committed WASM.

## Held-out results, complete pipeline (Edinburgh `etest`)

| SNR   | PESQ before | PESQ after | PESQ Krisp | Quietest 10% of speech frames, before → after |
| ----- | ----------: | ---------: | ---------: | --------------------------------------------- |
| −10   |       1.734 |      1.782 |      1.551 | −35.2 → −23.3 dB                              |
| −5    |       2.022 |      2.088 |      1.788 | −30.7 → −17.9 dB                              |
| 0     |       2.297 |      2.414 |      2.069 | −31.8 → −17.2 dB                              |
| 5     |       2.710 |      2.837 |      2.377 | −26.8 → −12.9 dB                              |
| 10    |       3.156 |      3.154 |      2.660 | −8.1 → −8.0 dB                                |
| 20    |       3.484 |      3.462 |      3.121 | −13.0 → −15.4 dB                              |
| clean |       4.483 |      4.488 |      3.754 | −4.3 → −4.3 dB                                |

Words are recognised within 20–30 ms of their start (median); starts recognised after more than 100 ms fall from 32%
to 5% at −10 dB SNR. Pauses between words under loud noise are a few dB less silent than with the old detector
(roughly −40 to −50 dB below the input) because the gate no longer closes on every dip of the SNR estimate.

## Remaining gaps

- With the gate open, the network alone still scores 0.06–0.11 PESQ higher than the gated pipeline from −10 to +5 dB.
  The rest is soft consonants and breaths before the voiced part of a word. Fixing that needs more look-ahead
  (latency) or a gate that attenuates instead of muting; a −30 dB closed level gained 0.01–0.04 PESQ.
- On rumble-heavy synthetic noise at −10 dB, Krisp removes 6 dB more noise during speech by sacrificing voice below
  300 Hz.
- Pink noise reaching down to DC passes the deep filter's two lowest bins (0–100 Hz) at about −3 dB. A direct edit
  of those bins fixed pink noise but made realistic low-frequency noise worse, so it was rejected.

## Rejected interventions

Global bias shifts of the SNR head or the ERB mask (they move speech and noise together), the low-bin deep-filter
edits above, and a static high-pass at 150–250 Hz. The high-pass raised PESQ on rumble but thinned clean voices.

## Validation

59 targeted Vitest tests pass with the committed WASM. Two new real-model tests (pink noise is not speech, and a word
after silence is recognised before its start reaches the output) fail on the previous WASM.
CPU cost is unchanged at about 0.25 s per second of audio in Node. Fitting data, Krisp outputs and scripts are kept
outside the repository; proprietary Krisp artifacts never enter it.
