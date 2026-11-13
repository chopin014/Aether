/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import {
    ImageCropView,
    type ImageCropShape,
    useCreateAutoDisposedViewModel,
    useViewModel,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";

import BaseDialog from "./BaseDialog";
import Modal from "../../../Modal";
import { _t } from "../../../languageHandler";
import { ImageCropViewModel, type ImageCropViewModelProps } from "../../../viewmodels/images/ImageCropViewModel";
import { isAnimatedImage } from "../../../utils/image/imageCrop";

/** What an edited image is for, which decides its shape and size. */
export type ImageCropPurpose = "avatar" | "icon" | "banner";

const PURPOSES: Record<ImageCropPurpose, { shape: ImageCropShape; aspectRatio: number; maxOutputWidth: number }> = {
    /** People and rooms, shown as circles. */
    avatar: { shape: "circle", aspectRatio: 1, maxOutputWidth: 512 },
    /** Spaces, shown as rounded squares. */
    icon: { shape: "rounded", aspectRatio: 1, maxOutputWidth: 512 },
    /** Profile banners, shown wide above the profile. */
    banner: { shape: "rectangle", aspectRatio: 3, maxOutputWidth: 1500 },
};

/** Hosts the image editor in a dialog. */
export function ImageCropDialog(props: ImageCropViewModelProps): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new ImageCropViewModel(props));
    const { busy } = useViewModel(vm);
    return (
        // Named by its own title: opened over another dialog, such as settings, the title would otherwise be
        // found by an ID both share.
        <BaseDialog
            title={_t("image_crop|title")}
            aria-label={_t("image_crop|title")}
            onFinished={vm.cancel}
            hasCancel={!busy}
            fixedWidth={false}
        >
            <ImageCropView vm={vm} />
        </BaseDialog>
    );
}

/** Decode an image file, or give nothing when the browser cannot show it. */
async function decodeImage(url: string): Promise<HTMLImageElement | undefined> {
    const image = new Image();
    image.src = url;
    try {
        await image.decode();
    } catch (error) {
        logger.warn("Unable to decode picked image", error);
        return undefined;
    }
    return image.naturalWidth && image.naturalHeight ? image : undefined;
}

/**
 * Let the person move, zoom and turn a picked image before it is used, like Discord's "Edit image".
 *
 * @param file The picked file.
 * @param purpose What the image is for.
 * @returns The file to use, or nothing when the person cancelled. Files the browser cannot draw, such as SVGs or
 *     unsupported formats, come back untouched.
 */
export async function editImage(file: File, purpose: ImageCropPurpose): Promise<File | undefined> {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return file;
    const imageUrl = URL.createObjectURL(file);
    try {
        const image = await decodeImage(imageUrl);
        if (!image) return file;
        // Settings dialogs are static modals, so they stay open, draft and all, underneath this one.
        const { finished } = Modal.createDialog(ImageCropDialog, {
            ...PURPOSES[purpose],
            file,
            image,
            imageUrl,
            imageWidth: image.naturalWidth,
            imageHeight: image.naturalHeight,
            animated: await isAnimatedImage(file),
        });
        const [result] = await finished;
        return result;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}
