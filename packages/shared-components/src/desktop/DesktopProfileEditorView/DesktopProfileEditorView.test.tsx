/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopProfileEditorView,
    type DesktopProfileEditorViewActions,
    type DesktopProfileEditorViewSnapshot,
} from "./DesktopProfileEditorView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DesktopProfileEditorViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopProfileEditorViewSnapshot>({
            state: "ready",
            draft: {
                displayName: "Robin",
                pronouns: "",
                bio: "",
                statusEmoji: "",
                statusText: "",
                hasNameplateImage: false,
                nameStyle: { font: "default", effect: "none" },
                links: [],
                boardTitle: "",
                board: [],
            },
            preview: { userId: "@robin:example.org", displayName: "Robin", roles: [] },
            hasBanner: false,
            hasAvatar: false,
            canSetDisplayName: true,
            canSetAvatar: true,
            tagOptions: [],
            dirty: false,
            saving: false,
            saved: false,
            tooLarge: false,
            maxLinks: 2,
            maxBoardItems: 2,
            ...snapshot,
        }),
        {
            update: vi.fn(),
            chooseAvatar: vi.fn(),
            removeAvatar: vi.fn(),
            chooseBanner: vi.fn(),
            removeBanner: vi.fn(),
            chooseNameplateImage: vi.fn(),
            surpriseName: vi.fn(),
            addLink: vi.fn(),
            updateLink: vi.fn(),
            removeLink: vi.fn(),
            addBoardItem: vi.fn(),
            updateBoardItem: vi.fn(),
            removeBoardItem: vi.fn(),
            save: vi.fn(),
            reset: vi.fn(),
        } satisfies DesktopProfileEditorViewActions,
    );
}

describe("DesktopProfileEditorView", () => {
    it("explains why the editor is unavailable instead of showing dead controls", () => {
        const { rerender } = render(<DesktopProfileEditorView vm={makeVm({ state: "unsupported" })} />);
        expect(screen.getByRole("alert").textContent).toContain("does not support custom profile fields");
        expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
        rerender(<DesktopProfileEditorView vm={makeVm({ state: "read_only" })} />);
        expect(screen.getByRole("alert").textContent).toContain("manages your profile");
    });

    it("says the profile is public", () => {
        render(<DesktopProfileEditorView vm={makeVm()} />);
        expect(screen.getByText(/Your profile is public/)).toBeVisible();
    });

    it("sends typed fields and picked decorations to the view model", async () => {
        const vm = makeVm();
        render(<DesktopProfileEditorView vm={vm} />);
        await userEvent.type(screen.getByLabelText("Pronouns"), "x");
        expect(vm.update).toHaveBeenCalledWith({ pronouns: "x" });
        await userEvent.click(screen.getByRole("radio", { name: "Flame crown" }));
        expect(vm.update).toHaveBeenCalledWith({ decoration: "flame-crown" });
        await userEvent.click(screen.getByRole("radio", { name: "Moonlit" }));
        expect(vm.update).toHaveBeenCalledWith({ nameplate: "moonlit", hasNameplateImage: false });
    });

    it("only offers the save bar when there is something to say", async () => {
        const { rerender } = render(<DesktopProfileEditorView vm={makeVm()} />);
        expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
        const vm = makeVm({ dirty: true });
        rerender(<DesktopProfileEditorView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
        expect(vm.save).toHaveBeenCalled();
        await userEvent.click(screen.getByRole("button", { name: "Reset" }));
        expect(vm.reset).toHaveBeenCalled();
    });

    it("blocks saving a profile too large to store and reports save failures", () => {
        const { rerender } = render(<DesktopProfileEditorView vm={makeVm({ dirty: true, tooLarge: true })} />);
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
        expect(screen.getByRole("alert").textContent).toContain("too much in it");
        rerender(<DesktopProfileEditorView vm={makeVm({ dirty: true, error: "Nope" })} />);
        expect(screen.getByRole("alert").textContent).toContain("Nope");
    });

    it("stops offering new links and board items at the limit", () => {
        const link = { label: "", url: "", invalid: false };
        render(
            <DesktopProfileEditorView
                vm={makeVm({
                    draft: {
                        ...makeVm().getSnapshot().draft,
                        links: [
                            { id: "1", ...link },
                            { id: "2", ...link },
                        ],
                        board: [
                            { id: "1", title: "a", caption: "" },
                            { id: "2", title: "b", caption: "" },
                        ],
                    },
                })}
            />,
        );
        expect(screen.queryByRole("button", { name: "Add link" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Add picture" })).toBeNull();
    });

    it("marks an unusable link address", () => {
        render(
            <DesktopProfileEditorView
                vm={makeVm({
                    draft: {
                        ...makeVm().getSnapshot().draft,
                        links: [{ id: "1", label: "x", url: "javascript:alert(1)", invalid: true }],
                    },
                })}
            />,
        );
        expect(screen.getByLabelText("Address")).toHaveAttribute("aria-invalid", "true");
    });

    it("passes a chosen banner to the view model", async () => {
        const vm = makeVm();
        render(<DesktopProfileEditorView vm={vm} />);
        const file = new File(["x"], "banner.png", { type: "image/png" });
        const input = document.querySelectorAll<HTMLInputElement>("input[type=file]")[1];
        await userEvent.upload(input, file);
        expect(vm.chooseBanner).toHaveBeenCalledWith(file);
    });

    it("shows the draft in the live preview", () => {
        render(
            <DesktopProfileEditorView
                vm={makeVm({
                    preview: {
                        userId: "@robin:example.org",
                        displayName: "Preview Name",
                        roles: [],
                        bio: "Preview bio",
                        status: { emoji: "🎧", text: "Listening" },
                        appearance: { decoration: "halo", nameplate: { preset: "tides" } },
                    },
                })}
            />,
        );
        expect(screen.getByRole("heading", { name: "Preview Name" })).toBeVisible();
        expect(screen.getByText("Preview bio")).toBeVisible();
        expect(document.querySelector('[data-decoration="halo"]')).not.toBeNull();
        expect(document.querySelector('[data-nameplate="tides"]')).not.toBeNull();
    });
});
