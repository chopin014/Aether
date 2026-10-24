/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Avatar } from "@vector-im/compound-web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "@vector-im/compound-web/dist/style.css";
import desktopShellCss from "../../../../res/css/structures/_DesktopShell.pcss?raw";

const avatarUrl = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="teal"/></svg>',
)}`;

describe("Desktop avatar frames", () => {
    let container: HTMLDivElement;
    let stylesheet: HTMLStyleElement;
    let root: Root;

    beforeEach(() => {
        stylesheet = document.createElement("style");
        // Exercise the actual desktop overrides and Compound avatar in a browser with real layout.
        stylesheet.textContent = desktopShellCss;
        document.head.appendChild(stylesheet);
        document.body.classList.add("mx_DesktopShell");
        container = document.createElement("div");
        container.className = "mx_MatrixChat_wrapper mx_MatrixChat_desktopShell";
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
        stylesheet.remove();
        document.body.classList.remove("mx_DesktopShell");
    });

    it.each([
        { surface: "server rail", size: "32px", expectedSize: 48 },
        { surface: "profile header", size: "40px", expectedSize: 28 },
    ])("fits the image to its frame in the $surface", async ({ surface, size, expectedSize }) => {
        const avatar = (
            <Avatar id="@alice:example.org" name="Alice" src={avatarUrl} size={size} className="mx_BaseAvatar" />
        );
        flushSync(() =>
            root.render(
                surface === "server rail" ? (
                    <nav className="mx_SpacePanel collapsed">
                        <div className="mx_SpaceButton mx_SpaceButton_narrow">
                            <div className="mx_SpaceButton_selectionWrapper">
                                <div className="mx_SpaceButton_avatarWrapper">{avatar}</div>
                            </div>
                        </div>
                    </nav>
                ) : (
                    <header className="mx_RoomHeader">{avatar}</header>
                ),
            ),
        );
        const image = container.querySelector("img")!;
        await image.decode();
        const frame = image.parentElement!;
        const frameBounds = frame.getBoundingClientRect();
        const imageBounds = image.getBoundingClientRect();

        expect(frameBounds.width).toBe(expectedSize);
        expect(frameBounds.height).toBe(expectedSize);
        expect(imageBounds.width).toBe(expectedSize);
        expect(imageBounds.height).toBe(expectedSize);
        expect(imageBounds.x).toBe(frameBounds.x);
        expect(imageBounds.y).toBe(frameBounds.y);
        expect(getComputedStyle(image).borderRadius).toBe(getComputedStyle(frame).borderRadius);
        expect(getComputedStyle(image).objectFit).toBe("cover");
    });
});
