/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { APP_EMBED_REFERRER, withEmbedReferrer } from "./embed-referrer.js";

describe("withEmbedReferrer", () => {
    it("names the app to the YouTube embed, which refuses to play otherwise", () => {
        expect(withEmbedReferrer("https://www.youtube.com/embed/aqz-KE-bpKQ?enablejsapi=1", { Accept: "*/*" })).toEqual(
            { Accept: "*/*", Referer: APP_EMBED_REFERRER },
        );
        expect(withEmbedReferrer("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ", {})).toEqual({
            Referer: APP_EMBED_REFERRER,
        });
    });

    it("keeps a Referer the page already sends", () => {
        expect(
            withEmbedReferrer("https://www.youtube.com/embed/x", { referer: "https://app.example/" }),
        ).toBeUndefined();
    });

    it("leaves every other request alone", () => {
        expect(withEmbedReferrer("https://www.youtube.com/watch?v=aqz-KE-bpKQ", {})).toBeUndefined();
        expect(withEmbedReferrer("https://evil.example/https://www.youtube.com/embed/x", {})).toBeUndefined();
        expect(withEmbedReferrer("https://matrix.example/_matrix/client/v1/media/download/x", {})).toBeUndefined();
    });
});
