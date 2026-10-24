/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Keeps native window colours in sync with the theme and the modal backdrops covering the app. */
export function watchWindowControlsTheme(update: (color: string, symbolColor: string) => void): () => void {
    let previous = "";
    let frame: number | undefined;
    let context: CanvasRenderingContext2D | null | undefined;
    const modalRoots = new Set<Element>();
    const rootIds = ["mx_Dialog_Container", "mx_Dialog_StaticContainer"];
    const sync = (): void => {
        const probe = document.createElement("div");
        probe.style.cssText =
            "position:fixed;visibility:hidden;pointer-events:none;background:var(--cpd-color-bg-canvas-default);color:var(--cpd-color-icon-secondary)";
        document.body.appendChild(probe);
        const styles = getComputedStyle(probe);
        let color = styles.backgroundColor;
        let symbolColor = styles.color;
        probe.remove();

        const backdrops = Array.from(document.querySelectorAll<HTMLElement>(".mx_Dialog_background"))
            .map((element) => ({ element, style: getComputedStyle(element) }))
            .filter(({ element, style }) => {
                const rect = element.getBoundingClientRect();
                return (
                    style.visibility !== "hidden" &&
                    rect.width > 0 &&
                    rect.top <= 0 &&
                    rect.right >= document.documentElement.clientWidth
                );
            })
            .sort((a, b) => (Number.parseInt(a.style.zIndex) || 0) - (Number.parseInt(b.style.zIndex) || 0));

        if (backdrops.length) {
            // Let the browser composite CSS colours and alpha exactly as it paints the backdrop.
            // These two pixels represent the window's background and icon before that backdrop is applied.
            if (context === undefined) {
                const canvas = document.createElement("canvas");
                canvas.width = 2;
                canvas.height = 1;
                context = canvas.getContext("2d", { willReadFrequently: true });
            }
            if (context) {
                context.globalAlpha = 1;
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                context.fillStyle = symbolColor;
                context.fillRect(1, 0, 1, 1);
                for (const { style } of backdrops) {
                    context.globalAlpha = Number.parseFloat(style.opacity) || 0;
                    context.fillStyle = style.backgroundColor;
                    context.fillRect(0, 0, 2, 1);
                }
                const { data } = context.getImageData(0, 0, 2, 1);
                color = `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
                symbolColor = `rgb(${data[4]}, ${data[5]}, ${data[6]})`;
            }
        }

        // CSS animations do not emit DOM mutations. Follow the fade so native chrome dims with the page.
        if (
            frame === undefined &&
            backdrops.some(({ element }) => element.getAnimations().some((a) => a.playState === "running"))
        ) {
            frame = requestAnimationFrame(() => {
                frame = undefined;
                sync();
            });
        }
        const next = `${color}|${symbolColor}`;
        if (!color || !symbolColor || next === previous) return;
        previous = next;
        update(color, symbolColor);
    };
    const observeModalRoots = (): void => {
        for (const id of rootIds) {
            const root = document.getElementById(id);
            if (!root || modalRoots.has(root)) continue;
            modalRoots.add(root);
            observer.observe(root, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["class", "style"],
            });
        }
    };
    const observer = new MutationObserver((mutations) => {
        // Observe modal portals, not the message timeline. Ignore the colour probe's own insertion/removal.
        const relevant = mutations.some(
            (mutation) =>
                mutation.type === "attributes" ||
                mutation.target !== document.body ||
                [...mutation.addedNodes, ...mutation.removedNodes].some(
                    (node) => node instanceof Element && rootIds.includes(node.id),
                ),
        );
        if (!relevant) return;
        observeModalRoots();
        sync();
    });
    observer.observe(document.body, { childList: true, attributes: true, attributeFilter: ["class", "style"] });
    // setTheme updates theme-color after the selected stylesheet finishes loading.
    observer.observe(document.head, { subtree: true, attributes: true, attributeFilter: ["content"] });
    observeModalRoots();
    const stop = (): void => {
        observer.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
        window.removeEventListener("pagehide", stop);
    };
    window.addEventListener("pagehide", stop, { once: true });
    sync();
    return stop;
}
