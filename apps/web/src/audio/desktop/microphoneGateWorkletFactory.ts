/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Load the isolated audio-thread module using the same public-path handling as the recorder worklet. */
export async function loadMicrophoneGateWorklet(context: AudioContext): Promise<void> {
    const { microphoneGateWorkletUrl } = await import("./MicrophoneGateWorklet");
    await context.audioWorklet.addModule(microphoneGateWorkletUrl);
}
