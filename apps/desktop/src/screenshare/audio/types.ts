/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Audio selected independently from the video source; application IDs come from the provider. */
export type ShareAudioTarget = { kind: "system" } | { kind: "application"; id: string };

/** An application currently available for playback capture. IDs are opaque to the renderer. */
export interface ShareAudioApplication {
    id: string;
    name: string;
}

/** Actual runtime support, including missing tools or unsupported operating system versions. */
export interface ShareAudioCapabilities {
    system: boolean;
    application: boolean;
    window: boolean;
    reason?: string;
}

/** All providers emit interleaved stereo float32 little-endian PCM at 48 kHz. */
export interface ShareAudioCallbacks {
    onData: (pcm: Buffer) => void;
    onError: (error: Error) => void;
    onStopped: () => void;
}

/** A ready capture session. Stop is idempotent and releases every child process and stream. */
export interface ShareAudioSession {
    stop: () => Promise<void>;
}

/** Main-process provider. Never silently broadens application capture to system capture. */
export interface ShareAudioProvider {
    capabilities: () => Promise<ShareAudioCapabilities>;
    listApplications: () => Promise<ShareAudioApplication[]>;
    resolveWindow: (sourceId: string) => Promise<string | null>;
    start: (
        target: ShareAudioTarget,
        excludedProcessIds: readonly number[],
        callbacks: ShareAudioCallbacks,
        signal?: AbortSignal,
    ) => Promise<ShareAudioSession>;
}
