/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Vite bundles this entry for browser tests; webpack uses our worklet loader for the same query.
// The asset query exports a URL rather than the worklet module.
// oxlint-disable-next-line import/default
import workletUrl from "./VoiceGateWorklet.ts?worker&url";

/** Load the compiled voice gate into the supplied audio context. */
export function loadVoiceGateWorklet(context: AudioContext): Promise<void> {
    return context.audioWorklet.addModule(workletUrl);
}
