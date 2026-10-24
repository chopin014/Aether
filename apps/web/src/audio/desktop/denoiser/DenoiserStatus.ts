/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * What became of noise suppression for a microphone: running, unable to start or run, or stopped because the
 * computer could not keep up with it.
 */
export type DenoiserStatus = "active" | "failed" | "overloaded";
