/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { ImageCropView, type ImageCropViewSnapshot } from "./ImageCropView";
import { MockViewModel } from "../../core/viewmodel";

function show(snapshot: Partial<ImageCropViewSnapshot> = {}) {
    const vm = Object.assign(
        new MockViewModel<ImageCropViewSnapshot>({
            imageUrl: "blob:picture",
            imageWidth: 1200,
            imageHeight: 800,
            shape: "circle",
            aspectRatio: 1,
            rotation: 0,
            zoom: 1,
            maxZoom: 5,
            centreX: 0.5,
            centreY: 0.5,
            animated: false,
            busy: false,
            ...snapshot,
        }),
        {
            setZoom: vi.fn(),
            moveBy: vi.fn(),
            rotate: vi.fn(),
            reset: vi.fn(),
            apply: vi.fn(),
            keepOriginal: vi.fn(),
            cancel: vi.fn(),
        },
    );
    const result = render(<ImageCropView vm={vm} />);
    return { vm, ...result };
}

describe("ImageCropView", () => {
    it("places the picture so the kept area fills the frame", () => {
        const { container } = show({ zoom: 2, centreX: 0.25 });
        // A 3:2 picture in a square frame: at zoom 2 the kept area is a third of the width and half the height.
        const box = container.querySelector("img")!.parentElement!;
        expect(box.style.width).toBe("300%");
        expect(box.style.height).toBe("200%");
        expect(box.style.left).toBe("-25%");
        expect(box.style.top).toBe("-50%");
    });

    it("turns the picture inside its box", () => {
        const { container } = show({ rotation: 1 });
        const picture = container.querySelector("img")!;
        expect(picture.style.transform).toBe("rotate(90deg)");
        // Turned, the 1200×800 picture is 800 wide, so the unturned picture is 150% of the box's width.
        expect(picture.style.width).toBe("150%");
        expect(parseFloat(picture.style.height)).toBeCloseTo(66.667, 2);
    });

    it("zooms with the slider and the keyboard", () => {
        const { vm } = show({ zoom: 1.5 });
        fireEvent.change(screen.getByRole("slider", { name: "Zoom" }), { target: { value: "2" } });
        expect(vm.setZoom).toHaveBeenLastCalledWith(2);
        const stage = screen.getByRole("application", { name: "Image position" });
        fireEvent.keyDown(stage, { key: "+" });
        expect(vm.setZoom).toHaveBeenLastCalledWith(1.6);
        fireEvent.keyDown(stage, { key: "-" });
        expect(vm.setZoom).toHaveBeenLastCalledWith(1.4);
    });

    it("zooms with the wheel", () => {
        const { vm } = show();
        fireEvent.wheel(screen.getByRole("application", { name: "Image position" }), { deltaY: -100 });
        expect(vm.setZoom.mock.calls[0][0]).toBeGreaterThan(1);
    });

    it("moves the picture with the arrow keys", () => {
        const { vm } = show();
        const stage = screen.getByRole("application", { name: "Image position" });
        fireEvent.keyDown(stage, { key: "ArrowRight" });
        // The kept area is two thirds of the width; one press moves it by a twentieth of that.
        expect(vm.moveBy.mock.calls[0][0]).toBeCloseTo(2 / 3 / 20);
        expect(vm.moveBy.mock.calls[0][1]).toBe(0);
        fireEvent.keyDown(stage, { key: "ArrowUp" });
        expect(vm.moveBy).toHaveBeenLastCalledWith(0, -0.05);
    });

    it("moves the picture by dragging", () => {
        const { vm, container } = show();
        const box = container.querySelector("img")!.parentElement!;
        vi.spyOn(box, "getBoundingClientRect").mockReturnValue({ width: 300, height: 200 } as DOMRect);
        const stage = screen.getByRole("application", { name: "Image position" });
        fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
        fireEvent.pointerMove(stage, { pointerId: 1, clientX: 130, clientY: 80 });
        expect(vm.moveBy).toHaveBeenCalledWith(-0.1, 0.1);
        fireEvent.pointerUp(stage, { pointerId: 1 });
        fireEvent.pointerMove(stage, { pointerId: 1, clientX: 200, clientY: 200 });
        expect(vm.moveBy).toHaveBeenCalledOnce();
    });

    it("rotates, resets, applies and cancels", async () => {
        const { vm } = show();
        await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
        expect(vm.rotate).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Reset" }));
        expect(vm.reset).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Apply" }));
        expect(vm.apply).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(vm.cancel).toHaveBeenCalledOnce();
    });

    it("offers to keep an animated picture as it is", async () => {
        const { vm } = show({ animated: true });
        expect(screen.getByText("Editing keeps only a still frame of an animated image.")).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Use original" }));
        expect(vm.keepOriginal).toHaveBeenCalledOnce();
    });

    it("shows a failure and holds every control while busy", () => {
        show({ busy: true, error: "Could not edit." });
        expect(screen.getByRole("alert")).toHaveTextContent("Could not edit.");
        expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
        expect(screen.getByRole("slider", { name: "Zoom" })).toBeDisabled();
    });
});
