/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * How long a released microphone's capture is kept open. Long enough for the leave cue to finish playing, and for a
 * replacement microphone to start, before Chromium stops the capture.
 */
export const CAPTURE_LINGER_MS = 2000;

/**
 * Keeps a microphone's capture open for a moment after the call lets go of it.
 *
 * Chromium mixes every sound the page plays through one output while an echo-cancelled microphone is open, so that
 * the echo canceller can hear it. About a second after the last such microphone stops, it switches back to separate
 * outputs, and that switch drops everything playing at the time for tens of milliseconds: the leave cue crackled,
 * and a microphone restarted mid-call made everyone's voice break up. A silent clone of the track keeps the same
 * capture running until {@link CAPTURE_LINGER_MS} after release; it is disabled, so it never carries audio anywhere.
 *
 * @param track - The microphone track the call captured.
 * @returns A release function: call it when the call has finished with the track. Calling it again does nothing.
 */
export function lingerCapture(track: MediaStreamTrack): () => void {
    let hold: MediaStreamTrack | undefined;
    try {
        hold = track.clone();
        hold.enabled = false;
    } catch {
        return () => {};
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const held = hold;
        hold = undefined;
        setTimeout(() => held?.stop(), CAPTURE_LINGER_MS);
    };
}
