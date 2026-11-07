/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { useRef } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@test-utils";

import { ProfileNameplate } from "./ProfileNameplate";
import { type ProfileNameplateValue } from "./profileCatalogue";

function Row({ nameplate, live = false }: { nameplate: ProfileNameplateValue; live?: boolean }): React.JSX.Element {
    const text = useRef<HTMLSpanElement>(null);
    return (
        <div data-testid="row" style={{ position: "relative", width: 240, height: 44 }}>
            <ProfileNameplate nameplate={nameplate} live={live} textRef={text} />
            <span ref={text} style={{ display: "inline-block", width: 90 }}>
                Robin
            </span>
        </div>
    );
}

describe("ProfileNameplate", () => {
    it("tints the row with the scene's colour and keeps the art faint behind the name", () => {
        const { container } = render(<Row nameplate={{ preset: "aurora" }} />);
        const plate = container.querySelector<HTMLElement>("[data-nameplate]")!;
        expect(plate).toHaveAttribute("data-nameplate", "aurora");
        expect(plate.style.getPropertyValue("--plate")).toBe("#2be8a6");
        // The text ends 90px in; the art reaches full strength just after it.
        expect(plate.style.getPropertyValue("--plate-text-end")).toBe("100px");
        expect(plate.querySelector("canvas")).not.toBeNull();
    });

    it("shows a person's still image at rest and adds the animated one while the row is active", () => {
        const nameplate = { imageUrl: "https://example.org/still.png", animatedUrl: "https://example.org/moving.gif" };
        const { container, rerender } = render(<Row nameplate={nameplate} />);
        const sources = (): string[] => [...container.querySelectorAll("img")].map((img) => img.getAttribute("src")!);
        expect(sources()).toEqual(["https://example.org/still.png"]);
        rerender(<Row nameplate={nameplate} live />);
        expect(sources()).toEqual(["https://example.org/still.png", "https://example.org/moving.gif"]);
        expect(screen.getByTestId("row").querySelector("[data-live]")).toHaveAttribute("data-live", "true");
    });
});
