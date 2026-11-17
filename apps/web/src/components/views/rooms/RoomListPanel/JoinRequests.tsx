/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { JoinRequestsView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import { JoinRequestsViewModel } from "../../../../viewmodels/desktop/JoinRequestsViewModel";

/** The requests to join a server, shown above its channels. Give it a `key` of the server's ID. */
export function JoinRequests({
    space,
}: {
    /** The server whose requests are shown. */
    space: Room;
}): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new JoinRequestsViewModel({ space }));
    return <JoinRequestsView vm={vm} />;
}
