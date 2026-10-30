/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Call data transport; sender identities come from validated MatrixRTC participant mappings. */
export interface SoundboardTransport {
    send(payload: Uint8Array): Promise<void>;
    subscribe(listener: (payload: Uint8Array, sender: string) => void): () => void;
}
