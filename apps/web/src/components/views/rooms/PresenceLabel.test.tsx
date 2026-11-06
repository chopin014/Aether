/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "test-utils-rtl";

import PresenceLabel from "./PresenceLabel";

describe("<PresenceLabel/>", () => {
    it("should render 'Offline' for presence=offline", () => {
        const { asFragment } = render(<PresenceLabel presenceState="offline" />);
        expect(asFragment()).toMatchInlineSnapshot(`
            <DocumentFragment>
              <div
                class="mx_PresenceLabel"
              >
                Offline
              </div>
            </DocumentFragment>
        `);
    });

    it.each([undefined, "unknown", "unsupported"])("should render Offline for unknown presence %s", (presence) => {
        const { getByText } = render(<PresenceLabel presenceState={presence} />);
        expect(getByText("Offline")).toBeInTheDocument();
    });

    it.each([undefined, "unknown", "unsupported"])(
        "should use the offline duration label for unknown presence %s",
        (presence) => {
            const { getByText } = render(<PresenceLabel presenceState={presence} activeAgo={120000} />);
            expect(getByText("Offline for 2m")).toBeInTheDocument();
        },
    );

    it("should render 'Unreachable' for presence=unreachable", () => {
        const { asFragment } = render(<PresenceLabel presenceState="io.element.unreachable" />);
        expect(asFragment()).toMatchInlineSnapshot(`
            <DocumentFragment>
              <div
                class="mx_PresenceLabel"
              >
                Account provider of the user is unreachable
              </div>
            </DocumentFragment>
        `);
    });
});
