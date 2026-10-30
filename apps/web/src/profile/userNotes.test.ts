/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { getUserNote, setUserNote, USER_NOTES_EVENT_TYPE, UserNotesFullError } from "./userNotes";

const ROBIN = "@robin:example.org";

function makeClient(notes: unknown): MatrixClient {
    return {
        getAccountData: vi.fn(() => ({ getContent: () => ({ notes }) })),
        setAccountData: vi.fn().mockResolvedValue(undefined),
    } as unknown as MatrixClient;
}

describe("user notes", () => {
    it("reads a note, and copes with malformed account data", () => {
        expect(getUserNote(makeClient({ [ROBIN]: "hi" }), ROBIN)).toBe("hi");
        expect(getUserNote(makeClient({ [ROBIN]: 5 }), ROBIN)).toBe("");
        expect(getUserNote(makeClient("nonsense"), ROBIN)).toBe("");
        expect(getUserNote(makeClient(undefined), ROBIN)).toBe("");
    });

    it("keeps notes about other people when saving one", async () => {
        const client = makeClient({ "@a:example.org": "kept" });
        await setUserNote(client, ROBIN, "  new  ");
        expect(client.setAccountData).toHaveBeenCalledWith(USER_NOTES_EVENT_TYPE, {
            notes: { "@a:example.org": "kept", [ROBIN]: "new" },
        });
    });

    it("removes an emptied note", async () => {
        const client = makeClient({ [ROBIN]: "old" });
        await setUserNote(client, ROBIN, "   ");
        expect(client.setAccountData).toHaveBeenCalledWith(USER_NOTES_EVENT_TYPE, { notes: {} });
    });

    it("refuses to grow past what account data can hold", async () => {
        const client = makeClient({ "@a:example.org": "x".repeat(70 * 1024) });
        await expect(setUserNote(client, ROBIN, "new")).rejects.toBeInstanceOf(UserNotesFullError);
        expect(client.setAccountData).not.toHaveBeenCalled();
    });
});
