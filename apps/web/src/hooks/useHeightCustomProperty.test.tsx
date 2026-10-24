/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React, { type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "test-utils-rtl";

import { useHeightCustomProperty } from "./useHeightCustomProperty";

function Measured(): JSX.Element {
    const ref = useHeightCustomProperty("--test-height");
    return <div ref={ref} />;
}

describe("useHeightCustomProperty", () => {
    let resize: () => void;
    const disconnect = vi.fn();

    beforeEach(() => {
        vi.stubGlobal(
            "ResizeObserver",
            class {
                public constructor(callback: () => void) {
                    resize = callback;
                }
                public observe = vi.fn();
                public disconnect = disconnect;
            },
        );
        vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(152);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("publishes the element's height and removes it on unmount", () => {
        const { unmount } = render(<Measured />);
        resize();
        expect(document.body.style.getPropertyValue("--test-height")).toBe("152px");
        unmount();
        expect(disconnect).toHaveBeenCalled();
        expect(document.body.style.getPropertyValue("--test-height")).toBe("");
    });
});
