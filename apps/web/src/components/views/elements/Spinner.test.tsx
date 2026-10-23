/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { render, screen } from "test-utils-rtl";
import { afterEach, describe, expect, it, vi } from "vitest";

import Spinner from "./Spinner";
import SettingsStore from "../../../settings/SettingsStore";

describe("<Spinner />", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows Aether's orbit at the requested size in the desktop shell", () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => name === "feature_desktop_shell");
        render(<Spinner size={48} onFinished={() => {}} />);

        const spinner = screen.getByRole("progressbar", { name: "Loading…" });
        expect(spinner).toHaveClass("mx_DesktopShell_spinner");
        expect(spinner).toHaveStyle({ width: "48px", height: "48px" });
    });

    it("keeps Compound's spinner elsewhere", () => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        render(<Spinner onFinished={() => {}} message="Joining" />);

        expect(screen.getByRole("progressbar", { name: "Loading…" })).not.toHaveClass("mx_DesktopShell_spinner");
        expect(screen.getByText("Joining")).toBeInTheDocument();
    });
});
