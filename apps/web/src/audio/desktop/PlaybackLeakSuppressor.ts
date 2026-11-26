/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { RealFft } from "./RealFft";

/** The samples handled per call, one audio worklet block, and the hop between analysis frames. */
export const LEAK_BLOCK = 128;
const FRAME = LEAK_BLOCK * 2;

/**
 * The bands the leak is estimated in, as bin ranges of a 256-point frame at 48 kHz (187.5 Hz per bin): narrow where
 * music and voices have most of their energy, wider above.
 */
const BAND_EDGES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 17, 20, 24, 28, 33, 39, 46, 54, 63, 74, 87, 102, 118, 129];
const BANDS = BAND_EDGES.length - 1;

/** The longest delay from what is played to its leak into the microphone that is looked for, in frames. */
const MAX_DELAY_FRAMES = 150;
/** How much past loudness the delay is estimated from, at least and at most, and how often. */
const ENVELOPE_FRAMES = 750;
const MIN_ENVELOPE_FRAMES = 560;
const DELAY_EVERY_FRAMES = 188;
/**
 * The estimate is used only when the loudness of the microphone follows the playback at least this closely. A real
 * headset's leak matched at 0.67 to 0.89, while a voice that has nothing to do with the playback matched up to 0.36.
 */
const MIN_DELAY_CORRELATION = 0.6;
/** How many delays are tried per frame while searching, which bounds the work done in any one audio block. */
const LAGS_PER_FRAME = 10;
/** Frames either side of the estimated delay that still count, since the delay drifts a little. */
const DELAY_SPREAD_FRAMES = 4;
/** The coupling is learned only while the smoothed playback changes by less than this power factor per frame. */
const STEADY_CHANGE = 1.05;
/** Playback quieter than this, as power per bin of a frame, is too faint to leak into anything. */
const REFERENCE_FLOOR = 1e-7;

/**
 * How strongly playback reaches the microphone is the smallest microphone-to-playback ratio seen over the last
 * {@link COUPLING_WINDOWS} windows of {@link COUPLING_WINDOW_FRAMES}: speech only ever adds to the microphone, and its
 * pauses leave the leak alone.
 */
const COUPLING_WINDOW_FRAMES = 94;
const COUPLING_WINDOWS = 6;
/** The leak estimate is raised by this power factor, since the smallest ratio of noisy measurements runs low. */
const OVERESTIMATE = 4;
/**
 * The smallest ratio may fall at once but rises by at most this factor per frame (1 dB a second): during long speech
 * every window holds voice, and a smallest ratio that jumped up with it would take the voice for leak.
 */
const COUPLING_RISE_PER_FRAME = 10 ** (LEAK_BLOCK / 48000 / 10);

/**
 * When noise suppression says whether someone is talking, the coupling is instead the ratio that the leak stays
 * under {@link LEAK_PERCENTILE} of the time while nobody talks. A headset's leak can grow faster than the playback,
 * so the smallest ratio would let its loud passages through. The estimate climbs by {@link PERCENTILE_STEP_DB} times
 * the percentile per frame above it and falls by the step times the rest below it, so one missed word moves it little.
 */
const LEAK_PERCENTILE = 0.97;
const PERCENTILE_STEP_DB = 0.1;
/**
 * A frame this many times louder than the leak the smallest ratio predicts is taken for speech whatever noise
 * suppression says: speech must never teach the percentile, or the voice would then be turned down as leak. Also
 * how frames are told apart when noise suppression is off.
 */
const SPEECH_MARGIN = 100;
/**
 * A band learns only while its own ratio is within this factor of its smallest one: the leak of a real headset
 * spread over about 17 dB, while a voice raises the bands it is in by far more.
 */
const BAND_SPEECH_MARGIN = 316;
/** After anything that sounds like speech, nothing is learned for this many frames (300 ms): words trail off softly. */
const SPEECH_HANGOVER_FRAMES = 113;
/**
 * Frames wait this long (about 107 ms) before they are learned from, and are dropped if speech is heard meanwhile:
 * words also start softly, too quietly at first to tell them from the leak.
 */
const LEARN_DELAY_FRAMES = 40;
/** Frames of learning, about one second, before the percentile is trusted over the smallest ratio. */
const PERCENTILE_READY_FRAMES = 375;
/** The percentile already covers the spread, so the leak predicted from it is raised only a little. */
const PERCENTILE_OVERESTIMATE = 2;
/** The deepest the microphone is turned down in a band: 40 dB. */
const MIN_GAIN = 0.01;

/**
 * Removes the sound of other applications that reaches the microphone: crosstalk inside a headset, which goes on
 * even when its microphone is muted, or speakers heard by the microphone.
 *
 * Given what the system plays as a reference, it learns for each frequency band how strongly and how late the
 * playback turns up in the microphone, and turns those bands down by as much as the predicted leak accounts for.
 * Working on loudness rather than waveforms, it also removes leaks that a headset's own processing has changed.
 * The output lags the input by {@link LEAK_BLOCK} samples.
 */
export class PlaybackLeakSuppressor {
    private readonly fft = new RealFft(FRAME);
    private readonly window = new Float32Array(FRAME);
    private readonly micFrame = new Float32Array(FRAME);
    private readonly referenceFrame = new Float32Array(FRAME);
    private readonly scratch = new Float32Array(FRAME);
    private readonly re = new Float32Array(FRAME / 2 + 1);
    private readonly im = new Float32Array(FRAME / 2 + 1);
    private readonly referenceRe = new Float32Array(FRAME / 2 + 1);
    private readonly referenceIm = new Float32Array(FRAME / 2 + 1);
    private readonly overlap = new Float32Array(LEAK_BLOCK);
    private readonly binGains = new Float32Array(FRAME / 2 + 1);

    /** Recent reference band powers, newest at {@link historyIndex}. */
    private readonly referenceHistory = new Float32Array(MAX_DELAY_FRAMES * BANDS);
    private historyIndex = 0;
    /** Microphone band power smoothed briefly, which the gains follow. */
    private readonly micPower = new Float32Array(BANDS);
    /** Microphone and delayed playback band powers smoothed alike, which the coupling and leak come from. */
    private readonly slowMicPower = new Float32Array(BANDS);
    private readonly slowReference = new Float32Array(BANDS);
    /** Playback band power at exactly the estimated delay, smoothed like the microphone, to learn the coupling. */
    private readonly exactReference = new Float32Array(BANDS);
    private readonly gains = new Float32Array(BANDS).fill(1);
    private readonly windowMinimum = new Float32Array(BANDS).fill(Infinity);
    private readonly pastMinima = new Float32Array(COUPLING_WINDOWS * BANDS).fill(Infinity);
    /** Each band's smallest ratio as used, which rises only slowly. Infinity while unknown. */
    private readonly smallestCoupling = new Float32Array(BANDS).fill(Infinity);
    private pastMinimaIndex = 0;
    private framesInWindow = 0;
    /** The percentile coupling of each band in dB, and how many frames have taught it. */
    private readonly percentileDb = new Float32Array(BANDS);
    private readonly percentileFrames = new Uint32Array(BANDS);

    private readonly micEnvelope = new Float32Array(ENVELOPE_FRAMES);
    private readonly referenceEnvelope = new Float32Array(ENVELOPE_FRAMES);
    private readonly referenceActive = new Uint8Array(ENVELOPE_FRAMES);
    private envelopeIndex = 0;
    private envelopeFrames = 0;
    private framesSinceDelay = 0;
    private delayFrames: number | null = null;
    /** Snapshot of the envelopes being searched, oldest first, so that later frames cannot change them. */
    private readonly searchMic = new Float32Array(ENVELOPE_FRAMES);
    private readonly searchReference = new Float32Array(ENVELOPE_FRAMES);
    private searchMicVariance = 0;
    /** Where the microphone side of the search starts in the snapshot. */
    private searchStart = MAX_DELAY_FRAMES;
    private nextLag = MAX_DELAY_FRAMES;
    private bestLag = -1;
    private bestCorrelation = 0;

    private readonly micSmoothing: number;
    private readonly slowSmoothing: number;
    /** Whether someone was heard talking, as passed to the current {@link process} call. */
    private speech?: boolean;
    /** Frames left before learning resumes after something that sounded like speech. */
    private speechHangover = 0;
    /** Ratios in dB waiting to be learned, per frame and band (NaN where a band has none), oldest at the index. */
    private readonly pendingRatios = new Float32Array(LEARN_DELAY_FRAMES * BANDS).fill(NaN);
    private pendingIndex = 0;

    /** @param sampleRate - The rate of both signals. The bands are laid out for 48 kHz. */
    public constructor(private readonly sampleRate: number) {
        // A periodic square-root Hann window used for analysis and synthesis sums to one at half-frame overlap.
        for (let i = 0; i < FRAME; i++) this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
        const frameSeconds = LEAK_BLOCK / sampleRate;
        this.micSmoothing = 1 - Math.exp(-frameSeconds / 0.008);
        // Slow enough to average out single frames, and to cover a leak ringing on after the playback stops.
        this.slowSmoothing = 1 - Math.exp(-frameSeconds / 0.05);
    }

    /** The estimated delay from playback to the microphone in milliseconds, or null while it is unknown. */
    public get delayMs(): number | null {
        return this.delayFrames === null ? null : (this.delayFrames * LEAK_BLOCK * 1000) / this.sampleRate;
    }

    /**
     * Processes one block of {@link LEAK_BLOCK} samples.
     * @param mic - The microphone.
     * @param reference - What the system played at the same time, or undefined when there is no reference.
     * @param output - Where the cleaned microphone goes; may be the same array as `mic`.
     * @param speech - Whether someone was just heard talking, or undefined when nothing can tell.
     */
    public process(
        mic: Float32Array,
        reference: Float32Array | undefined,
        output: Float32Array,
        speech?: boolean,
    ): void {
        this.speech = speech;
        this.micFrame.copyWithin(0, LEAK_BLOCK);
        this.micFrame.set(mic, LEAK_BLOCK);
        this.referenceFrame.copyWithin(0, LEAK_BLOCK);
        if (reference) this.referenceFrame.set(reference, LEAK_BLOCK);
        else this.referenceFrame.fill(0, LEAK_BLOCK);

        for (let i = 0; i < FRAME; i++) this.scratch[i] = this.referenceFrame[i] * this.window[i];
        this.fft.forward(this.scratch, this.referenceRe, this.referenceIm);
        for (let i = 0; i < FRAME; i++) this.scratch[i] = this.micFrame[i] * this.window[i];
        this.fft.forward(this.scratch, this.re, this.im);

        this.analyse();
        this.applyGains();

        this.fft.inverse(this.re, this.im, this.scratch);
        for (let i = 0; i < LEAK_BLOCK; i++) {
            output[i] = this.overlap[i] + this.scratch[i] * this.window[i];
            this.overlap[i] = this.scratch[i + LEAK_BLOCK] * this.window[i + LEAK_BLOCK];
        }
    }

    /** Updates the band powers, the delay and coupling estimates, and the band gains for the current frame. */
    private analyse(): void {
        this.historyIndex = (this.historyIndex + 1) % MAX_DELAY_FRAMES;
        const historyRow = this.historyIndex * BANDS;
        let micTotal = 0;
        let referenceTotal = 0;
        let referenceBinsActive = 0;
        for (let band = 0; band < BANDS; band++) {
            let mic = 0;
            let reference = 0;
            for (let bin = BAND_EDGES[band]; bin < BAND_EDGES[band + 1]; bin++) {
                mic += this.re[bin] * this.re[bin] + this.im[bin] * this.im[bin];
                reference +=
                    this.referenceRe[bin] * this.referenceRe[bin] + this.referenceIm[bin] * this.referenceIm[bin];
            }
            this.referenceHistory[historyRow + band] = reference;
            this.micPower[band] += this.micSmoothing * (mic - this.micPower[band]);
            this.slowMicPower[band] += this.slowSmoothing * (mic - this.slowMicPower[band]);
            micTotal += mic;
            referenceTotal += reference;
            if (reference > REFERENCE_FLOOR * (BAND_EDGES[band + 1] - BAND_EDGES[band])) referenceBinsActive++;
        }
        this.recordEnvelope(micTotal, referenceTotal, referenceBinsActive > 0);
        this.updateCoupling();
        const heard = this.speech === true || !this.onlyLeakHeard();
        if (heard) {
            this.speechHangover = SPEECH_HANGOVER_FRAMES;
            // The frames just before were the start of it.
            this.pendingRatios.fill(NaN);
        } else if (this.speechHangover > 0) {
            this.speechHangover--;
        }
        const pendingRow = this.pendingIndex * BANDS;
        for (let band = 0; band < BANDS; band++) {
            const ratioDb = this.pendingRatios[pendingRow + band];
            if (!Number.isNaN(ratioDb)) this.learnPercentile(band, ratioDb);
        }
        this.pendingRatios.fill(NaN, pendingRow, pendingRow + BANDS);
        const learnPercentile = this.speechHangover === 0;
        // Nobody has talked for a while and the microphone holds no more than the leak could explain: whatever
        // the playback reaches is removed in full, however far its loud passages outgrow the learned coupling.
        const onlyLeak = !heard && this.speechHangover === 0;

        for (let band = 0; band < BANDS; band++) {
            const width = BAND_EDGES[band + 1] - BAND_EDGES[band];
            // Both sides are smoothed alike: single frames vary so much that their smallest ratio would sit far below
            // the real one. The leak is predicted from the loudest playback around the delay, to allow for drift.
            this.slowReference[band] += this.slowSmoothing * (this.delayedReference(band) - this.slowReference[band]);
            const reference = this.slowReference[band];
            const playing = reference > REFERENCE_FLOOR * width;
            if (this.delayFrames !== null) {
                // The coupling is learned at the exact delay, and only while the playback holds steady: at onsets
                // and before the delay is known, the playback runs ahead of its leak and the ratio dips.
                const previous = this.exactReference[band];
                const exact = previous + this.slowSmoothing * (this.referenceAt(this.delayFrames, band) - previous);
                this.exactReference[band] = exact;
                const steady = exact < previous * STEADY_CHANGE && exact > previous / STEADY_CHANGE;
                if (steady && exact > REFERENCE_FLOOR * width && this.slowMicPower[band] > 0) {
                    const ratio = this.slowMicPower[band] / exact;
                    // A voice is never the leak, so nothing is learned while noise suppression hears one.
                    if (this.speech !== true) this.windowMinimum[band] = Math.min(this.windowMinimum[band], ratio);
                    const smallest = this.coupling(band);
                    if (learnPercentile && ratio <= BAND_SPEECH_MARGIN * smallest) {
                        this.pendingRatios[pendingRow + band] = 10 * Math.log10(ratio);
                    }
                }
            }

            const mic = this.micPower[band];
            let leak = 0;
            if (playing && this.percentileFrames[band] >= PERCENTILE_READY_FRAMES) {
                leak = PERCENTILE_OVERESTIMATE * 10 ** (this.percentileDb[band] / 10) * reference;
            } else if (playing) {
                const coupling = this.coupling(band);
                if (Number.isFinite(coupling)) leak = OVERESTIMATE * coupling * reference;
            }
            let gain = leak > 0 && mic > 0 ? Math.sqrt(Math.max(MIN_GAIN * MIN_GAIN, 1 - leak / mic)) : 1;
            if (onlyLeak && leak > 0) gain = MIN_GAIN;
            // Turn down at once, so a leak never slips through, but come back up gently to avoid warbling.
            this.gains[band] = gain < this.gains[band] ? gain : this.gains[band] + 0.3 * (gain - this.gains[band]);
        }

        this.pendingIndex = (this.pendingIndex + 1) % LEARN_DELAY_FRAMES;

        if (++this.framesInWindow >= COUPLING_WINDOW_FRAMES) {
            this.pastMinima.set(this.windowMinimum, this.pastMinimaIndex * BANDS);
            this.pastMinimaIndex = (this.pastMinimaIndex + 1) % COUPLING_WINDOWS;
            this.windowMinimum.fill(Infinity);
            this.framesInWindow = 0;
        }
    }

    /** The loudest recent reference in a band around the estimated delay, or over all delays while it is unknown. */
    private delayedReference(band: number): number {
        const from = this.delayFrames === null ? 0 : Math.max(0, this.delayFrames - DELAY_SPREAD_FRAMES);
        const to =
            this.delayFrames === null
                ? MAX_DELAY_FRAMES - 1
                : Math.min(MAX_DELAY_FRAMES - 1, this.delayFrames + DELAY_SPREAD_FRAMES);
        let loudest = 0;
        for (let lag = from; lag <= to; lag++) loudest = Math.max(loudest, this.referenceAt(lag, band));
        return loudest;
    }

    /**
     * Whether the microphone holds no more than the leak could explain: within {@link SPEECH_MARGIN} of what the
     * smallest ratios predict, over the bands where the playback is known to leak. False while nothing is known.
     */
    private onlyLeakHeard(): boolean {
        let mic = 0;
        let leak = 0;
        for (let band = 0; band < BANDS; band++) {
            const coupling = this.coupling(band);
            if (!Number.isFinite(coupling)) continue;
            mic += this.slowMicPower[band];
            leak += coupling * this.slowReference[band];
        }
        return leak > 0 && mic <= SPEECH_MARGIN * leak;
    }

    /** Moves a band's percentile coupling towards one ratio, in dB, heard while nobody talked. */
    private learnPercentile(band: number, ratioDb: number): void {
        if (this.percentileFrames[band]++ === 0) {
            this.percentileDb[band] = ratioDb;
            return;
        }
        this.percentileDb[band] +=
            ratioDb > this.percentileDb[band]
                ? PERCENTILE_STEP_DB * LEAK_PERCENTILE
                : -PERCENTILE_STEP_DB * (1 - LEAK_PERCENTILE);
    }

    /** The reference power of a band `lag` frames ago. */
    private referenceAt(lag: number, band: number): number {
        const row = (this.historyIndex - lag + MAX_DELAY_FRAMES) % MAX_DELAY_FRAMES;
        return this.referenceHistory[row * BANDS + band];
    }

    /** Sets the delay, forgetting the coupling learned at the old one when it moved further than the spread. */
    private setDelay(frames: number): void {
        if (this.delayFrames !== null && Math.abs(frames - this.delayFrames) <= DELAY_SPREAD_FRAMES) {
            this.delayFrames = frames;
            return;
        }
        this.delayFrames = frames;
        this.windowMinimum.fill(Infinity);
        this.pastMinima.fill(Infinity);
        this.smallestCoupling.fill(Infinity);
        this.exactReference.fill(0);
        this.percentileFrames.fill(0);
        this.pendingRatios.fill(NaN);
    }

    /** The smallest microphone-to-playback power ratio of a band over the recent windows, or Infinity if none. */
    private coupling(band: number): number {
        return this.smallestCoupling[band];
    }

    /** Follows each band's smallest recent ratio down at once and up slowly, see {@link COUPLING_RISE_PER_FRAME}. */
    private updateCoupling(): void {
        for (let band = 0; band < BANDS; band++) {
            let smallest = this.windowMinimum[band];
            for (let w = 0; w < COUPLING_WINDOWS; w++) smallest = Math.min(smallest, this.pastMinima[w * BANDS + band]);
            const current = this.smallestCoupling[band];
            if (!Number.isFinite(smallest)) continue;
            this.smallestCoupling[band] = Number.isFinite(current)
                ? Math.min(smallest, current * COUPLING_RISE_PER_FRAME)
                : smallest;
        }
    }

    /** Spreads the band gains over the bins, smoothing the steps between bands, and applies them to the spectrum. */
    private applyGains(): void {
        for (let band = 0; band < BANDS; band++) {
            for (let bin = BAND_EDGES[band]; bin < BAND_EDGES[band + 1]; bin++) this.binGains[bin] = this.gains[band];
        }
        const last = this.binGains.length - 1;
        let previous = this.binGains[0];
        for (let bin = 0; bin <= last; bin++) {
            const current = this.binGains[bin];
            const next = this.binGains[Math.min(last, bin + 1)];
            const gain = 0.25 * previous + 0.5 * current + 0.25 * next;
            previous = current;
            this.re[bin] *= gain;
            this.im[bin] *= gain;
        }
    }

    /** Keeps the loudness history the delay is estimated from, and works on the current estimate. */
    private recordEnvelope(micPower: number, referencePower: number, referenceActive: boolean): void {
        this.envelopeIndex = (this.envelopeIndex + 1) % ENVELOPE_FRAMES;
        this.micEnvelope[this.envelopeIndex] = Math.log10(micPower + 1e-12);
        this.referenceEnvelope[this.envelopeIndex] = Math.log10(referencePower + 1e-12);
        this.referenceActive[this.envelopeIndex] = referenceActive ? 1 : 0;
        this.envelopeFrames = Math.min(ENVELOPE_FRAMES, this.envelopeFrames + 1);
        if (this.nextLag < MAX_DELAY_FRAMES) this.searchLags();
        else if (++this.framesSinceDelay >= DELAY_EVERY_FRAMES && this.envelopeFrames >= MIN_ENVELOPE_FRAMES) {
            this.framesSinceDelay = 0;
            this.startDelaySearch();
        }
    }

    /**
     * Starts looking for the delay at which the microphone's loudness best follows the playback's. Skipped while
     * the playback was mostly silent, since silence matches anything.
     */
    private startDelaySearch(): void {
        // Only the frames recorded so far count, the newest at the end.
        const first = ENVELOPE_FRAMES - this.envelopeFrames;
        let active = 0;
        for (let i = 0; i < ENVELOPE_FRAMES; i++) {
            const index = (this.envelopeIndex + 1 + i) % ENVELOPE_FRAMES;
            this.searchMic[i] = this.micEnvelope[index];
            this.searchReference[i] = this.referenceEnvelope[index];
            if (i >= first) active += this.referenceActive[index];
        }
        if (active < this.envelopeFrames * 0.8) return;
        // The microphone side is the newest frames, compared with playback from `lag` frames earlier.
        const start = first + MAX_DELAY_FRAMES;
        this.searchStart = start;
        let mean = 0;
        for (let i = start; i < ENVELOPE_FRAMES; i++) mean += this.searchMic[i];
        mean /= ENVELOPE_FRAMES - start;
        this.searchMicVariance = 0;
        for (let i = start; i < ENVELOPE_FRAMES; i++) {
            this.searchMic[i] -= mean;
            this.searchMicVariance += this.searchMic[i] * this.searchMic[i];
        }
        this.nextLag = 0;
        this.bestLag = -1;
        this.bestCorrelation = MIN_DELAY_CORRELATION;
    }

    /**
     * Tries a few delays per frame, so the search never holds up one audio block. Keeps the old delay when nothing
     * matches well, as while someone talks over the playback.
     */
    private searchLags(): void {
        const start = this.searchStart;
        const count = ENVELOPE_FRAMES - start;
        for (let tried = 0; tried < LAGS_PER_FRAME && this.nextLag < MAX_DELAY_FRAMES; tried++, this.nextLag++) {
            const lag = this.nextLag;
            let mean = 0;
            for (let i = start; i < ENVELOPE_FRAMES; i++) mean += this.searchReference[i - lag];
            mean /= count;
            let product = 0;
            let variance = 0;
            for (let i = start; i < ENVELOPE_FRAMES; i++) {
                const r = this.searchReference[i - lag] - mean;
                product += this.searchMic[i] * r;
                variance += r * r;
            }
            if (this.searchMicVariance === 0 || variance === 0) continue;
            const correlation = product / Math.sqrt(this.searchMicVariance * variance);
            if (correlation > this.bestCorrelation) {
                this.bestCorrelation = correlation;
                this.bestLag = lag;
            }
        }
        if (this.nextLag >= MAX_DELAY_FRAMES && this.bestLag >= 0) this.setDelay(this.bestLag);
    }
}
