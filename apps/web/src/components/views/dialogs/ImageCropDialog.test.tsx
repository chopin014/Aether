/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { render, screen } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editImage, ImageCropDialog } from "./ImageCropDialog";
import Modal from "../../../Modal";

describe("ImageCropDialog", () => {
    it("hosts the editor and gives up when cancelled", async () => {
        const onFinished = vi.fn();
        render(
            <ImageCropDialog
                file={new File(["x"], "a.png", { type: "image/png" })}
                image={{} as CanvasImageSource}
                imageUrl="blob:picture"
                imageWidth={100}
                imageHeight={100}
                shape="circle"
                aspectRatio={1}
                maxOutputWidth={512}
                animated={false}
                onFinished={onFinished}
            />,
        );
        expect(screen.getByRole("heading", { name: "Edit image" })).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onFinished).toHaveBeenCalledWith();
    });
});

describe("editImage", () => {
    let decode: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        URL.createObjectURL = vi.fn(() => "blob:picture");
        URL.revokeObjectURL = vi.fn();
        decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockResolvedValue(undefined);
        vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
        vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(480);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("passes files it cannot draw straight through", async () => {
        const createDialog = vi.spyOn(Modal, "createDialog");
        const svg = new File(["<svg/>"], "a.svg", { type: "image/svg+xml" });
        expect(await editImage(svg, "avatar")).toBe(svg);
        decode.mockRejectedValue(new Error("unsupported"));
        const heic = new File(["x"], "a.heic", { type: "image/heic" });
        expect(await editImage(heic, "avatar")).toBe(heic);
        expect(createDialog).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:picture");
    });

    it("opens the editor shaped for its purpose and returns its answer", async () => {
        const edited = new File(["y"], "a.png", { type: "image/png" });
        const createDialog = vi
            .spyOn(Modal, "createDialog")
            .mockReturnValue({ finished: Promise.resolve([edited]), close: vi.fn() });
        const file = new File(["x"], "a.gif", { type: "image/gif" });
        expect(await editImage(file, "banner")).toBe(edited);
        expect(createDialog).toHaveBeenCalledWith(
            ImageCropDialog,
            expect.objectContaining({
                file,
                shape: "rectangle",
                aspectRatio: 3,
                imageWidth: 640,
                imageHeight: 480,
                animated: true,
            }),
        );
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:picture");
    });

    it("returns nothing when the editor is dismissed", async () => {
        vi.spyOn(Modal, "createDialog").mockReturnValue({ finished: Promise.resolve([]), close: vi.fn() });
        expect(await editImage(new File(["x"], "a.png", { type: "image/png" }), "icon")).toBeUndefined();
    });
});
