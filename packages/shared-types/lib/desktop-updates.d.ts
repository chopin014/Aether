/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** The current state of the desktop application's release updater. */
export type DesktopUpdateState = {
    /** Current update lifecycle status. */
    status: "idle" | "checking" | "downloading" | "ready" | "error" | "unsupported";
    /** Version currently running. */
    currentVersion: string;
    /** Version available for download or ready to install. */
    version?: string;
    /** Download completion percentage, from zero to one hundred. */
    percent?: number;
    /** Unix timestamp in milliseconds for the most recent completed check. */
    lastChecked?: number;
    /** Why this installation cannot update. */
    reason?: "disabled" | "development" | "package" | "platform";
};
