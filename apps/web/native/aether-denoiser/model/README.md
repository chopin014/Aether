<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# DeepFilterNet3, edited for Aether

`DeepFilterNet3_aether.tar.gz` is the upstream DeepFilterNet3 ONNX archive (DeepFilterNet rev `d375b2d8`,
`models/DeepFilterNet3_onnx.tar.gz`) with one direct edit to the encoder's `lsnr` output. No layer was retrained and
the denoising itself is unchanged: the decoders and every existing tensor are byte-identical to upstream.
`edits.json` lists the added tensors and nodes with their exact values and the hashes of the original and edited
graphs.

## The speech score for the microphone gate (`lsnr`)

`lsnr` estimated SNR and was never a speech detector. On pink noise or babble with nobody speaking it reported
speech on about 90% of frames, it reported +4 dB in silence, and under loud noise it often recognised a word only
100 ms or more after it began. Aether's runtime thresholds keep both decoders on, so the gate in `MicrophoneGate` is
the only reader of `lsnr`. The edit turns it into a speech score with the same scale and cut-off (−8 dB):

```
lsnr = max(50 * sigmoid(emb @ w + b) - 15, original_lsnr - 28)
```

- `w`, `b` (513 values) are a logistic read-out of the existing 512-unit embedding that the original head also
  reads, fitted to "someone is speaking" from clean reference tracks. The first 150 ms of each utterance is weighted
  more, because a miss there clips the start of the word.
- The second term keeps the original head for clearly clean speech: an original estimate of 20 dB or more still
  counts as speech.

Both terms stay above −15 dB, so the native thresholds (−15, 35, 35) still apply both decoders on every frame.

## Measured effect

Held-out mixtures of real 48 kHz noise recordings (bus, café, living room, office, public square) and a speaker
never used to fit the edit, complete Aether pipeline including the gate:

- PESQ improves by 0.05 to 0.13 from −10 to +5 dB SNR and is unchanged within 0.02 at higher SNR and on clean
  speech.
- The quietest 10% of speech frames lose 12 to 15 dB less to the gate from −10 to +5 dB SNR; the share of cut
  speech frames falls at every SNR.
- Words are recognised within 20–30 ms of their start (median); starts recognised after more than 100 ms fall from
  32% to 5% at −10 dB.
- Pink noise with nobody speaking no longer holds the gate open: −27.6 dB → −37.7 dB.

Pauses between words under loud noise are a few dB less silent than before (around −40 to −50 dB below the input),
because the gate no longer closes on every dip of the old SNR estimate.

The fitting data, the comparisons with other suppressors and the scripts that produced this archive are kept outside
the repository with the rest of the noise suppression research.
