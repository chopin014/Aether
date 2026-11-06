/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    clampCropCentre,
    type ImageCropRotation,
    type ImageCropShape,
    type ImageCropViewActions,
    type ImageCropViewSnapshot,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";

import { _t } from "../../languageHandler";
import { croppedFileName, renderImageCrop } from "../../utils/image/imageCrop";

/** How far in the editor lets a person zoom. */
export const MAX_IMAGE_CROP_ZOOM = 5;

/** The picked image and what the result is for. */
export interface ImageCropViewModelProps {
    /** The picked file. */
    file: File;
    /** The decoded picked image. */
    image: CanvasImageSource;
    /** Address the editor shows the picked image from. */
    imageUrl: string;
    /** Width of the decoded image, before turning. */
    imageWidth: number;
    /** Height of the decoded image, before turning. */
    imageHeight: number;
    shape: ImageCropShape;
    /** Width over height of the result. */
    aspectRatio: number;
    /** The widest the result may be. */
    maxOutputWidth: number;
    /** The picked file moves, and editing it keeps a still frame. */
    animated: boolean;
    /** Called with the file to use, or nothing when the person gives up. */
    onFinished: (file?: File) => void;
}

/** Backs the image editor shown before an avatar, icon or banner is set. */
export class ImageCropViewModel
    extends BaseViewModel<ImageCropViewSnapshot, ImageCropViewModelProps>
    implements ImageCropViewActions
{
    public constructor(props: ImageCropViewModelProps) {
        super(props, {
            imageUrl: props.imageUrl,
            imageWidth: props.imageWidth,
            imageHeight: props.imageHeight,
            shape: props.shape,
            aspectRatio: props.aspectRatio,
            rotation: 0,
            zoom: 1,
            maxZoom: MAX_IMAGE_CROP_ZOOM,
            centreX: 0.5,
            centreY: 0.5,
            animated: props.animated,
            busy: false,
        });
    }

    /** Store a new position, keeping the kept area inside the image. */
    private place(patch: { rotation?: ImageCropRotation; zoom?: number; centreX?: number; centreY?: number }): void {
        const next = { ...this.snapshot.current, ...patch };
        const centre = clampCropCentre(next, next.centreX, next.centreY);
        this.snapshot.merge({ ...patch, centreX: centre.x, centreY: centre.y });
    }

    public setZoom = (zoom: number): void => {
        if (this.snapshot.current.busy || !Number.isFinite(zoom)) return;
        this.place({ zoom: Math.min(MAX_IMAGE_CROP_ZOOM, Math.max(1, zoom)) });
    };

    public moveBy = (x: number, y: number): void => {
        const { busy, centreX, centreY } = this.snapshot.current;
        if (busy) return;
        this.place({ centreX: centreX + x, centreY: centreY + y });
    };

    public rotate = (): void => {
        const { busy, rotation, centreX, centreY } = this.snapshot.current;
        if (busy) return;
        // Follow the same spot of the picture as it turns clockwise.
        this.place({ rotation: ((rotation + 1) % 4) as ImageCropRotation, centreX: 1 - centreY, centreY: centreX });
    };

    public reset = (): void => {
        if (this.snapshot.current.busy) return;
        this.snapshot.merge({ rotation: 0, zoom: 1, centreX: 0.5, centreY: 0.5, error: undefined });
    };

    public apply = async (): Promise<void> => {
        const current = this.snapshot.current;
        if (current.busy) return;
        this.snapshot.merge({ busy: true, error: undefined });
        try {
            const blob = await renderImageCrop(
                this.props.image,
                { ...current, maxOutputWidth: this.props.maxOutputWidth },
                this.props.file.type,
            );
            if (this.isDisposed) return;
            this.props.onFinished(
                new File([blob], croppedFileName(this.props.file.name, blob.type), { type: blob.type }),
            );
        } catch (error) {
            logger.warn("Unable to edit image", error);
            if (!this.isDisposed) this.snapshot.merge({ busy: false, error: _t("image_crop|error") });
        }
    };

    public keepOriginal = (): void => {
        if (!this.snapshot.current.busy) this.props.onFinished(this.props.file);
    };

    public cancel = (): void => {
        if (!this.snapshot.current.busy) this.props.onFinished();
    };
}
