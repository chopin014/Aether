/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { DesktopMessageSearchStore } from "./DesktopMessageSearchStore";
import { parseQuery } from "../utils/desktopSearch/query";

describe("DesktopMessageSearchStore", () => {
    it("starts and closes searches, announcing each change", () => {
        const store = new DesktopMessageSearchStore();
        const listener = vi.fn();
        store.on("update", listener);
        expect(store.active).toBeNull();

        store.start(parseQuery("has:file"), { kind: "room", roomIds: ["!a:x"] });
        expect(store.active).toMatchObject({ scope: { roomIds: ["!a:x"] }, query: { filters: [{ key: "has" }] } });
        const first = store.active!.id;
        store.start(parseQuery("other"), { kind: "room", roomIds: ["!a:x"] });
        expect(store.active!.id).not.toBe(first);

        store.close();
        store.close();
        expect(store.active).toBeNull();
        expect(listener).toHaveBeenCalledTimes(3);
    });
});
