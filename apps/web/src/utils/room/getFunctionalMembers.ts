/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type Room, UNSTABLE_ELEMENT_FUNCTIONAL_USERS } from "matrix-js-sdk/src/matrix";

/**
 * The room's functional members, such as bots, which are left out of its name and of call ringing.
 * @param room - The room.
 * @returns Their user IDs, from the `io.element.functional_members` event with an empty state key.
 */
export const getFunctionalMembers = (room: Room): string[] => {
    // Only the empty state key counts, and it is the one sliding sync asks for.
    const functionalUsersStateEvent = room.currentState.getStateEvents(UNSTABLE_ELEMENT_FUNCTIONAL_USERS.name, "");

    if (Array.isArray(functionalUsersStateEvent?.getContent().service_members)) {
        return functionalUsersStateEvent.getContent().service_members;
    }

    return [];
};
