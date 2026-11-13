/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Far below anything an output device can reproduce, but not zero, so Chromium never sees the output as silent. */
export const INAUDIBLE_LEVEL = 1e-20;

/**
 * Keeps a context that only feeds a MediaStream running on the audio device's clock.
 *
 * Chromium moves a context whose speaker output has been exactly zero for 30 seconds onto a timer-driven sink.
 * On Windows those timers fire about every 15.6 ms instead of every 10 ms, so the context then renders only about
 * two thirds of real time and drops the rest of its input. A constant, inaudible output keeps it on the device.
 * The source is released when the context closes.
 */
export function keepRealtimeClock(context: BaseAudioContext): void {
    const source = context.createConstantSource();
    source.offset.value = INAUDIBLE_LEVEL;
    source.connect(context.destination);
    source.start();
}
