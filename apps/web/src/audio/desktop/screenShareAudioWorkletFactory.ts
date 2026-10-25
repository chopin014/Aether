/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Load the playback worklet through the same public-path handling as Element's other audio worklets. */
export async function loadScreenShareAudioWorklet(context: AudioContext): Promise<void> {
    const { screenShareAudioWorkletUrl } = await import("./ScreenShareAudioWorklet");
    await context.audioWorklet.addModule(screenShareAudioWorkletUrl);
}
