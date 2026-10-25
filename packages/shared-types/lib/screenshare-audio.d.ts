/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Capture an application's playback, the shared window's application, or other system playback. */
export type ScreenShareAudioTarget = { kind: "system" } | { kind: "window" } | { kind: "application"; id: string };

/** Native playback capture support detected on the current machine. */
export interface ScreenShareAudioCapabilities {
    system: boolean;
    application: boolean;
    window: boolean;
    reason?: string;
}

/** A native playback application; its identifier is not an operating system PID. */
export interface ScreenShareAudioApplication {
    id: string;
    name: string;
}

/** Explicit audio opt-in associated with a video source approved by the desktop picker. */
export interface ScreenShareAudioRequest {
    id: string;
    videoSourceId: string;
    target: ScreenShareAudioTarget;
}

/** Bounded packets of interleaved, little-endian float32 stereo audio at 48 kHz. */
export type ScreenShareAudioEvent =
    | { type: "data"; id: string; sequence: number; pcm: Uint8Array }
    | { type: "stopped"; id: string; error?: string };

/** Narrow desktop bridge. The renderer must stop capture when its shared video track ends. */
export interface ScreenShareAudioApi {
    capabilities: () => Promise<ScreenShareAudioCapabilities>;
    applications: () => Promise<ScreenShareAudioApplication[]>;
    start: (request: ScreenShareAudioRequest) => Promise<void>;
    stop: (id: string) => Promise<void>;
    onEvent: (listener: (event: ScreenShareAudioEvent) => void) => () => void;
}
