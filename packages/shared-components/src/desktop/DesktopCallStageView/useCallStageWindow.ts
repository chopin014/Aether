/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useCallback, useEffect, useRef, useState } from "react";

interface CallPictureInPicture {
    requestWindow(options: { width: number; height: number }): Promise<Window>;
}

/** Move the stage through a React portal while capture and audio stay in the original call. */
export function useCallStageWindow(): {
    popoutWindow: Window | null;
    canPopout: boolean;
    popoutFailed: boolean;
    openPopout: (source?: HTMLElement | null) => Promise<void>;
} {
    const api = (window as Window & { documentPictureInPicture?: CallPictureInPicture }).documentPictureInPicture;
    const [popoutWindow, setPopoutWindow] = useState<Window | null>(null);
    const [popoutFailed, setPopoutFailed] = useState(false);
    const current = useRef<Window | null>(null);
    const mounted = useRef(true);
    const opening = useRef(false);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            current.current?.close();
        };
    }, []);

    const openPopout = useCallback(
        async (source?: HTMLElement | null): Promise<void> => {
            if (!api || opening.current) return;
            if (current.current && !current.current.closed) {
                current.current.focus();
                return;
            }
            opening.current = true;
            setPopoutFailed(false);
            try {
                const target = await api.requestWindow({ width: 960, height: 640 });
                if (!mounted.current) {
                    target.close();
                    return;
                }
                current.current = target;
                const doc = target.document;
                const base = doc.createElement("base");
                base.href = document.baseURI;
                doc.head.appendChild(base);
                doc.documentElement.lang = document.documentElement.lang;
                doc.documentElement.className = document.documentElement.className;
                doc.body.className = document.body.className;
                doc.body.style.margin = "0";
                doc.body.style.height = "100vh";
                doc.title = document.title;
                for (const sheet of document.styleSheets) {
                    try {
                        const style = doc.createElement("style");
                        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
                        doc.head.appendChild(style);
                    } catch {
                        // Cross-origin sheets cannot expose their rules, but may still be loaded by URL.
                        if (sheet.href) {
                            const link = doc.createElement("link");
                            link.rel = "stylesheet";
                            link.href = sheet.href;
                            doc.head.appendChild(link);
                        }
                    }
                }
                // A custom app theme can be defined on an ancestor rather than on the document root.
                const computed = getComputedStyle(source ?? document.body);
                for (const property of computed) {
                    if (property.startsWith("--")) {
                        doc.documentElement.style.setProperty(property, computed.getPropertyValue(property));
                    }
                }
                target.addEventListener(
                    "pagehide",
                    () => {
                        current.current = null;
                        if (mounted.current) setPopoutWindow(null);
                    },
                    { once: true },
                );
                setPopoutWindow(target);
            } catch {
                if (mounted.current) setPopoutFailed(true);
            } finally {
                opening.current = false;
            }
        },
        [api],
    );

    return { popoutWindow, canPopout: Boolean(api), popoutFailed, openPopout };
}
