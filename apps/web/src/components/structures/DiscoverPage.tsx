/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect } from "react";
import { DiscoverView } from "@element-hq/web-shared-components";

import { type DiscoverViewModel } from "../../viewmodels/discover/DiscoverViewModel";

/** The Discover page. Its model outlives the page, so the first visit is what loads the directory. */
export function DiscoverPage({ vm }: { vm: DiscoverViewModel }): JSX.Element {
    useEffect(() => vm.start(), [vm]);
    return <DiscoverView vm={vm} />;
}
