/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** PCM samples supplied by the native desktop capture backend. */
export interface DesktopAudioPacket {
    sessionId: string;
    data: Uint8Array;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    isFloat: boolean;
}

/** Narrow bridge for audio from a user-confirmed desktop source. */
export interface DesktopAudioApi {
    prepare: (audio: boolean) => Promise<void>;
    start: (sessionId: string) => Promise<boolean>;
    stop: (sessionId: string) => Promise<void>;
    onData: (listener: (packet: DesktopAudioPacket) => void) => () => void;
}
