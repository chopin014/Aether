/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Keeps native window colours in sync with the resolved Compound theme for the lifetime of the page. */
export function watchWindowControlsTheme(update: (color: string, symbolColor: string) => void): () => void {
    let previous = "";
    const sync = (): void => {
        const probe = document.createElement("div");
        probe.style.cssText =
            "position:fixed;visibility:hidden;pointer-events:none;background:var(--cpd-color-bg-canvas-default);color:var(--cpd-color-icon-secondary)";
        document.body.appendChild(probe);
        const styles = getComputedStyle(probe);
        const color = styles.backgroundColor;
        const symbolColor = styles.color;
        probe.remove();
        const next = `${color}|${symbolColor}`;
        if (!color || !symbolColor || next === previous) return;
        previous = next;
        update(color, symbolColor);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    // setTheme updates theme-color after the selected stylesheet finishes loading.
    observer.observe(document.head, { subtree: true, attributes: true, attributeFilter: ["content"] });
    const stop = (): void => {
        observer.disconnect();
        window.removeEventListener("pagehide", stop);
    };
    window.addEventListener("pagehide", stop, { once: true });
    sync();
    return stop;
}
