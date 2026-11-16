/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type IContent } from "matrix-js-sdk/src/matrix";

/**
 * A field Aether adds to the `m.space.child` event of a channel it creates: `true` when every member of the Space can
 * join the channel straight away, `false` when they can't, such as for an invite-only channel or a nested Space.
 * Members' clients then join a new channel without first asking the server about it. Other clients ignore the field.
 */
export const SPACE_CHILD_JOINABLE_FIELD = "io.aether.joinable";

/** What a child event says about whether the Space's members can join it, or undefined when it says nothing. */
export function readJoinableHint(content: IContent): boolean | undefined {
    const hint = content[SPACE_CHILD_JOINABLE_FIELD];
    return typeof hint === "boolean" ? hint : undefined;
}
