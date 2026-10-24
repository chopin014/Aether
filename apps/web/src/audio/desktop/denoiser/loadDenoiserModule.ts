/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

let compiled: Promise<WebAssembly.Module> | undefined;

/**
 * Fetches and compiles the noise suppression once, for every microphone worklet to instantiate. The file is
 * large, so it is only fetched the first time a call or microphone test wants it. A failure is retried next time.
 */
export function loadDenoiserModule(): Promise<WebAssembly.Module> {
    compiled ??= (async (): Promise<WebAssembly.Module> => {
        const { default: url } = await import("./aether-denoiser.wasm");
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not fetch noise suppression: ${response.status}`);
        return WebAssembly.compile(await response.arrayBuffer());
    })();
    compiled.catch(() => {
        compiled = undefined;
    });
    return compiled;
}
