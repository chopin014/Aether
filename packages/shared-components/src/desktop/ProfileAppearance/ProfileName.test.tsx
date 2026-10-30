/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@test-utils";

import { PROFILE_NAME_FONTS } from "./profileCatalogue";
import { ProfileName } from "./ProfileName";

describe("ProfileName", () => {
    it("is plain text without a style", () => {
        render(<ProfileName>Robin</ProfileName>);
        expect(screen.getByText("Robin")).not.toHaveAttribute("data-font");
    });

    it("draws a gradient only when there are colours for it", () => {
        const { rerender } = render(
            <ProfileName nameStyle={{ font: "default", effect: "gradient" }}>Robin</ProfileName>,
        );
        expect(screen.getByText("Robin")).toHaveAttribute("data-name-effect", "none");
        rerender(
            <ProfileName nameStyle={{ font: "default", effect: "gradient", colour: "#ff0000" }}>Robin</ProfileName>,
        );
        expect(screen.getByText("Robin")).toHaveAttribute("data-name-effect", "gradient");
    });

    // A taller line pushes the name off the centre of a member row, away from the plain names around it.
    it.each(PROFILE_NAME_FONTS)("does not make its line taller with the %s font", (font) => {
        const line = { font: "500 17px/24px sans-serif", width: "300px" };
        render(
            <>
                <div data-testid="plain" style={line}>
                    <span>Robin</span>
                </div>
                <div data-testid="styled" style={line}>
                    <span>
                        <ProfileName nameStyle={{ font, effect: "none" }}>Robin</ProfileName>
                    </span>
                </div>
            </>,
        );
        const plain = screen.getByTestId("plain").getBoundingClientRect().height;
        expect(Math.abs(screen.getByTestId("styled").getBoundingClientRect().height - plain)).toBeLessThanOrEqual(1);
    });
});
