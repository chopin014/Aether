/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

/** Account data holding private notes about people. This is not part of the Matrix specification. */
export const USER_NOTES_EVENT_TYPE = "io.aether.user_notes";

/** Account data events are limited to 64 KiB. Stay clear of it rather than fail the person's save partway. */
const MAX_NOTES_BYTES = 60 * 1024;

/** A set of notes cannot grow any further. */
export class UserNotesFullError extends Error {}

function readNotes(client: MatrixClient): Record<string, string> {
    // The SDK only types account data defined by the specification.
    const notes = client.getAccountData(USER_NOTES_EVENT_TYPE as never)?.getContent()?.notes;
    if (typeof notes !== "object" || notes === null) return {};
    return Object.fromEntries(
        Object.entries(notes).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
}

/** The viewer's note about this person. Empty when there is none. */
export function getUserNote(client: MatrixClient, userId: string): string {
    return readNotes(client)[userId] ?? "";
}

/** Save the viewer's note about this person. An empty note removes it. */
export async function setUserNote(client: MatrixClient, userId: string, note: string): Promise<void> {
    const notes = readNotes(client);
    const trimmed = note.trim();
    if (trimmed) notes[userId] = trimmed;
    else delete notes[userId];
    const content = { notes };
    if (new TextEncoder().encode(JSON.stringify(content)).length > MAX_NOTES_BYTES) throw new UserNotesFullError();
    await client.setAccountData(USER_NOTES_EVENT_TYPE as never, content as never);
}
