/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@test-utils";

import { PresenceGlyph, type PresenceGlyphStatus } from "./PresenceGlyph";

describe("PresenceGlyph", () => {
    it("draws a different shape for every state, so colour is never the only difference", () => {
        const statuses: PresenceGlyphStatus[] = ["online", "unavailable", "busy", "offline"];
        const shapes = statuses.map((status) => {
            const { container, unmount } = render(<PresenceGlyph status={status} />);
            const html = container.querySelector("svg")!.innerHTML;
            unmount();
            return html;
        });
        expect(new Set(shapes).size).toBe(statuses.length);
    });

    it("is decorative unless the caller gives it a name", () => {
        const { container, rerender } = render(<PresenceGlyph status="online" />);
        expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        rerender(<PresenceGlyph status="online" aria-hidden={false} aria-label="Online" />);
        expect(container.querySelector("svg")).toHaveAttribute("aria-label", "Online");
    });
});
