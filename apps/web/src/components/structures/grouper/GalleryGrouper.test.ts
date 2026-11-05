/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { MsgType } from "matrix-js-sdk/src/matrix";
import { mkEvent } from "test-utils";

import { galleryColumns, isGalleryMedia } from "./GalleryGrouper";

function message(content: Record<string, unknown>): ReturnType<typeof mkEvent> {
    return mkEvent({ event: true, type: "m.room.message", room: "!room", user: "@alice:example.org", content });
}

const picture = { msgtype: MsgType.Image, body: "photo.png", url: "mxc://example.org/photo" };

describe("isGalleryMedia", () => {
    it("takes pictures", () => {
        expect(isGalleryMedia(message(picture), false)).toBe(true);
    });

    it("leaves text, files and videos in their own rows", () => {
        expect(isGalleryMedia(message({ msgtype: MsgType.Text, body: "hi" }), true)).toBe(false);
        expect(isGalleryMedia(message({ ...picture, msgtype: MsgType.File }), true)).toBe(false);
        expect(isGalleryMedia(message({ ...picture, msgtype: MsgType.Video }), true)).toBe(false);
    });

    it("lets only the first picture carry text or a reply", () => {
        const captioned = message({ ...picture, filename: "photo.png", body: "look at this" });
        const reply = message({ ...picture, "m.relates_to": { "m.in_reply_to": { event_id: "$earlier" } } });

        expect(isGalleryMedia(captioned, true)).toBe(true);
        expect(isGalleryMedia(captioned, false)).toBe(false);
        expect(isGalleryMedia(reply, true)).toBe(true);
        expect(isGalleryMedia(reply, false)).toBe(false);
    });
});

describe("galleryColumns", () => {
    it.each([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 2],
        [5, 3],
        [9, 3],
    ])("lays %i pictures in %i columns", (count, columns) => {
        expect(galleryColumns(count)).toBe(columns);
    });
});
