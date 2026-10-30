/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { MatrixEvent } from "matrix-js-sdk/src/matrix";

import shouldHideEvent from "./shouldHideEvent";
import { SOUNDBOARD_EVENT, SOUNDBOARD_PLAY } from "./audio/soundboard/Soundboard";

describe("soundboard timeline visibility", () => {
    it.each([SOUNDBOARD_EVENT, SOUNDBOARD_PLAY])("hides %s from chat", (type) => {
        expect(shouldHideEvent(new MatrixEvent({ type, content: {} }))).toBe(true);
    });
});
