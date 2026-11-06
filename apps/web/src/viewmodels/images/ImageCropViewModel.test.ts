/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImageCropViewModel, MAX_IMAGE_CROP_ZOOM, type ImageCropViewModelProps } from "./ImageCropViewModel";
import { renderImageCrop } from "../../utils/image/imageCrop";

vi.mock("../../utils/image/imageCrop", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../utils/image/imageCrop")>()),
    renderImageCrop: vi.fn(),
}));

function make(props: Partial<ImageCropViewModelProps> = {}): ImageCropViewModel {
    return new ImageCropViewModel({
        file: new File(["x"], "holiday.jpeg", { type: "image/jpeg" }),
        image: {} as CanvasImageSource,
        imageUrl: "blob:picture",
        imageWidth: 1200,
        imageHeight: 800,
        shape: "circle",
        aspectRatio: 1,
        maxOutputWidth: 512,
        animated: false,
        onFinished: vi.fn(),
        ...props,
    });
}

describe("ImageCropViewModel", () => {
    beforeEach(() => {
        vi.mocked(renderImageCrop).mockReset();
    });

    it("starts with the whole image centred", () => {
        expect(make().getSnapshot()).toMatchObject({
            imageUrl: "blob:picture",
            shape: "circle",
            rotation: 0,
            zoom: 1,
            maxZoom: MAX_IMAGE_CROP_ZOOM,
            centreX: 0.5,
            centreY: 0.5,
            busy: false,
        });
    });

    it("keeps the zoom in range", () => {
        const vm = make();
        vm.setZoom(0.2);
        expect(vm.getSnapshot().zoom).toBe(1);
        vm.setZoom(50);
        expect(vm.getSnapshot().zoom).toBe(MAX_IMAGE_CROP_ZOOM);
        vm.setZoom(Number.NaN);
        expect(vm.getSnapshot().zoom).toBe(MAX_IMAGE_CROP_ZOOM);
    });

    it("keeps the kept area inside the image while moving and zooming out", () => {
        const vm = make();
        // At zoom 1 a square from a 3:2 picture can only move sideways.
        vm.moveBy(-1, 0.3);
        expect(vm.getSnapshot()).toMatchObject({ centreX: 1 / 3, centreY: 0.5 });
        vm.setZoom(2);
        vm.moveBy(0, -1);
        expect(vm.getSnapshot()).toMatchObject({ centreX: 1 / 3, centreY: 0.25 });
        vm.setZoom(1);
        expect(vm.getSnapshot()).toMatchObject({ centreX: 1 / 3, centreY: 0.5 });
    });

    it("follows the same spot as the image turns", () => {
        const vm = make();
        vm.setZoom(4);
        vm.moveBy(-0.3, -0.3);
        expect(vm.getSnapshot()).toMatchObject({ centreX: 0.2, centreY: 0.2 });
        vm.rotate();
        expect(vm.getSnapshot()).toMatchObject({ rotation: 1, centreX: 0.8, centreY: 0.2 });
        vm.rotate();
        vm.rotate();
        vm.rotate();
        expect(vm.getSnapshot().rotation).toBe(0);
    });

    it("resets to the whole image", () => {
        const vm = make();
        vm.setZoom(3);
        vm.rotate();
        vm.moveBy(0.1, 0.1);
        vm.reset();
        expect(vm.getSnapshot()).toMatchObject({ rotation: 0, zoom: 1, centreX: 0.5, centreY: 0.5 });
    });

    it("gives back the edited image as a file named after the original", async () => {
        const onFinished = vi.fn();
        const vm = make({ onFinished });
        vm.setZoom(2);
        vi.mocked(renderImageCrop).mockResolvedValue(new Blob(["y"], { type: "image/jpeg" }));
        await vm.apply();
        expect(renderImageCrop).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ zoom: 2, aspectRatio: 1, maxOutputWidth: 512, imageWidth: 1200 }),
            "image/jpeg",
        );
        const file: File = onFinished.mock.calls[0][0];
        expect(file.name).toBe("holiday.jpg");
        expect(file.type).toBe("image/jpeg");
    });

    it("says so when the image cannot be made, and lets the person try again", async () => {
        const onFinished = vi.fn();
        const vm = make({ onFinished });
        vi.mocked(renderImageCrop).mockRejectedValue(new Error("no canvas"));
        await vm.apply();
        expect(onFinished).not.toHaveBeenCalled();
        expect(vm.getSnapshot()).toMatchObject({ busy: false, error: expect.stringMatching(/could not be edited/) });
        vm.reset();
        expect(vm.getSnapshot().error).toBeUndefined();
    });

    it("ignores everything while the image is being made", async () => {
        const onFinished = vi.fn();
        const vm = make({ onFinished });
        let finish!: (blob: Blob) => void;
        vi.mocked(renderImageCrop).mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const applying = vm.apply();
        expect(vm.getSnapshot().busy).toBe(true);
        vm.setZoom(3);
        vm.moveBy(0.1, 0);
        vm.rotate();
        vm.reset();
        vm.cancel();
        vm.keepOriginal();
        await vm.apply();
        expect(vm.getSnapshot()).toMatchObject({ zoom: 1, rotation: 0, centreX: 0.5 });
        expect(renderImageCrop).toHaveBeenCalledOnce();
        finish(new Blob(["y"], { type: "image/png" }));
        await applying;
        expect(onFinished).toHaveBeenCalledOnce();
    });

    it("does not answer after it is closed", async () => {
        const onFinished = vi.fn();
        const vm = make({ onFinished });
        let finish!: (blob: Blob) => void;
        vi.mocked(renderImageCrop).mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const applying = vm.apply();
        vm.dispose();
        finish(new Blob(["y"], { type: "image/png" }));
        await applying;
        expect(onFinished).not.toHaveBeenCalled();
    });

    it("keeps the original or gives up", () => {
        const onFinished = vi.fn();
        const file = new File(["x"], "party.gif", { type: "image/gif" });
        const vm = make({ onFinished, file, animated: true });
        expect(vm.getSnapshot().animated).toBe(true);
        vm.keepOriginal();
        expect(onFinished).toHaveBeenLastCalledWith(file);
        vm.cancel();
        expect(onFinished).toHaveBeenLastCalledWith();
    });
});
