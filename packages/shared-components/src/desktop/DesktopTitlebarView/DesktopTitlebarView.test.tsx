/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@test-utils";

import { DesktopTitlebarView } from "./DesktopTitlebarView";
import { MockViewModel } from "../../core/viewmodel";

describe("DesktopTitlebarView", () => {
    it("shows the actual selected Space name", () => {
        render(<DesktopTitlebarView vm={new MockViewModel({ title: "Studio", displaySpaceMenu: true })} />);
        expect(screen.getByText("Studio")).toBeVisible();
    });
    it("shows the existing Home title outside a Space", () => {
        render(<DesktopTitlebarView vm={new MockViewModel({ title: "Home", displaySpaceMenu: false })} />);
        expect(screen.getByText("Home")).toBeVisible();
    });
});
