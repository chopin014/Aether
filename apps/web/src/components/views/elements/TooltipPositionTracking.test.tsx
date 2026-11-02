/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Tooltip, TooltipProvider } from "@vector-im/compound-web";

/**
 * Compound keeps closed label tooltips mounted, so these check our patch (patches/@vector-im__compound-web) that only
 * tracks a tooltip's position while it is open. Position tracking watches the trigger with a ResizeObserver, which is
 * what these count.
 */
describe("Compound tooltip position tracking", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    beforeEach(() => {
        vi.stubGlobal(
            "ResizeObserver",
            class {
                public observe = observe;
                public unobserve = vi.fn();
                public disconnect = disconnect;
            },
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        observe.mockClear();
        disconnect.mockClear();
    });

    const tooltip = (open: boolean): React.JSX.Element => (
        <TooltipProvider>
            <Tooltip label="Server 0" open={open}>
                <button>trigger</button>
            </Tooltip>
        </TooltipProvider>
    );

    it("does not track a closed tooltip, and starts and stops tracking as it opens and closes", () => {
        const { rerender } = render(tooltip(false));
        expect(observe).not.toHaveBeenCalled();

        rerender(tooltip(true));
        expect(observe).toHaveBeenCalled();

        rerender(tooltip(false));
        expect(disconnect).toHaveBeenCalled();
    });

    it("tracks a tooltip that is open when it mounts", () => {
        render(tooltip(true));
        expect(observe).toHaveBeenCalled();
    });
});
