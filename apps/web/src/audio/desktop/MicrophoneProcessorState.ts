/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MicrophoneGateConfig } from "./MicrophoneGate";

/** Complete gate state, sent together so a worklet never combines stale shortcut and mode values. */
export interface MicrophoneProcessorState {
    config: MicrophoneGateConfig;
    pushToTalkActive: boolean;
    shortcutMuted: boolean;
}

/** What the worklet is created with: the first state, and the compiled noise suppression if it is wanted. */
export interface MicrophoneGateWorkletOptions extends MicrophoneProcessorState {
    denoiserModule?: WebAssembly.Module;
}
