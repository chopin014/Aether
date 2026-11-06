/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";

import { SpaceAvatar } from "./SpaceBasicSettings";
import { editImage } from "../dialogs/ImageCropDialog";

vi.mock("../dialogs/ImageCropDialog", () => ({ editImage: vi.fn() }));

describe("<SpaceAvatar />", () => {
    it("frames a picked icon as a rounded square before using it", async () => {
        const setAvatar = vi.fn();
        const picked = new File(["x"], "icon.jpg", { type: "image/jpeg" });
        const edited = new File(["y"], "icon.jpg", { type: "image/jpeg" });
        vi.mocked(editImage).mockResolvedValueOnce(edited);
        const { container } = render(<SpaceAvatar setAvatar={setAvatar} />);

        await userEvent.upload(container.querySelector("input")!, picked);
        expect(editImage).toHaveBeenCalledWith(picked, "icon");
        expect(setAvatar).toHaveBeenCalledWith(edited);
        await waitFor(() => expect(screen.getByRole("button", { name: "Delete avatar" })).toBeVisible());
    });

    it("keeps the current icon when framing is cancelled", async () => {
        const setAvatar = vi.fn();
        vi.mocked(editImage).mockResolvedValueOnce(undefined);
        const { container } = render(<SpaceAvatar setAvatar={setAvatar} />);

        await userEvent.upload(container.querySelector("input")!, new File(["x"], "icon.png", { type: "image/png" }));
        expect(setAvatar).not.toHaveBeenCalled();
    });
});
