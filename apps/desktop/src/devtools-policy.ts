/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Whether the window may open Chromium's developer tools.
 *
 * The developer tools can read the session's access token and run any script as the signed-in user, which is how
 * "paste this into the console" scams take accounts. Release builds only allow them when started with `--devtools`.
 *
 * @param args The parsed command line.
 * @param isPackaged Whether this is a release build.
 */
export function devToolsAllowed(args: { devtools: boolean }, isPackaged: boolean): boolean {
    return !isPackaged || args.devtools;
}
