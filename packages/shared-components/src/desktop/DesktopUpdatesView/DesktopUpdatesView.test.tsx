/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";

import { MockViewModel } from "../../core/viewmodel";
import {
    DesktopUpdatesView,
    type DesktopUpdatesViewActions,
    type DesktopUpdatesViewSnapshot,
} from "./DesktopUpdatesView";

function makeViewModel(
    state: DesktopUpdatesViewSnapshot["state"],
    actions: Partial<DesktopUpdatesViewActions> = {},
): MockViewModel<DesktopUpdatesViewSnapshot> & DesktopUpdatesViewActions {
    return Object.assign(new MockViewModel<DesktopUpdatesViewSnapshot>({ state, loading: false }), {
        checkForUpdates: actions.checkForUpdates ?? vi.fn(),
        restartToUpdate: actions.restartToUpdate ?? vi.fn(),
    });
}

describe("DesktopUpdatesView", () => {
    it("shows the current version and allows a manual check", () => {
        const checkForUpdates = vi.fn();
        render(
            <DesktopUpdatesView vm={makeViewModel({ status: "idle", currentVersion: "1.4.2" }, { checkForUpdates })} />,
        );

        expect(screen.getByText("1.4.2")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
        expect(
            screen.getByText("Aether checks for new versions automatically and downloads them in the background."),
        ).toBeInTheDocument();
    });

    it("shows the checking state and prevents a second check", () => {
        render(<DesktopUpdatesView vm={makeViewModel({ status: "checking", currentVersion: "1.4.2" })} />);

        expect(screen.getByRole("status")).toHaveTextContent("Checking for updates…");
        expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
        expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    });

    it("shows progress while the update downloads", () => {
        render(
            <DesktopUpdatesView
                vm={makeViewModel({
                    status: "downloading",
                    currentVersion: "1.4.2",
                    version: "1.5.0",
                    percent: 42.847234,
                })}
            />,
        );

        expect(screen.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("value", "42.847234");
        expect(screen.getByText("Downloading version 1.5.0 (43 percent)")).toBeInTheDocument();
        expect(screen.getByText("You can keep using Aether while the update downloads.")).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveAttribute("aria-live", "off");
        expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
        expect(
            screen.getByRole("progressbar", { name: "Download progress" }).getBoundingClientRect().width,
        ).toBeGreaterThan(200);
    });

    it("lets the user retry after an update check fails", () => {
        const checkForUpdates = vi.fn();
        render(
            <DesktopUpdatesView
                vm={makeViewModel({ status: "error", currentVersion: "1.4.2" }, { checkForUpdates })}
            />,
        );

        screen.getByRole("button", { name: "Try again" }).click();
        expect(checkForUpdates).toHaveBeenCalledOnce();
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Couldn't update Aether. Check your connection and try again.",
        );
        expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    });

    it("offers the fixed release page when automatic updates are unsupported", () => {
        render(
            <DesktopUpdatesView
                vm={makeViewModel({ status: "unsupported", currentVersion: "1.4.2", reason: "package" })}
            />,
        );

        expect(screen.getByRole("link", { name: "Download the latest release" })).toHaveAttribute(
            "href",
            "https://github.com/chopin014/Aether/releases/latest",
        );
        expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
    });

    it("offers a direct restart when the update is ready", () => {
        const restartToUpdate = vi.fn();
        render(
            <DesktopUpdatesView
                vm={makeViewModel({ status: "ready", currentVersion: "1.4.2", version: "1.5.0" }, { restartToUpdate })}
            />,
        );

        screen.getByRole("button", { name: "Restart to update" }).click();
        expect(restartToUpdate).toHaveBeenCalledOnce();
        expect(screen.getByText("Aether installs the update the next time you quit normally.")).toBeInTheDocument();
    });
});
