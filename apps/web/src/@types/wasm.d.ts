/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** WebAssembly modules that webpack copies as files; the import is the file's URL. */
declare module "*.wasm" {
    const url: string;
    export default url;
}
