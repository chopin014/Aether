/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type DiscoverSection } from "@element-hq/web-shared-components";

import { type ActionPayload } from "../payloads";
import { type Action } from "../actions";

/** Opens the Discover page, optionally on a section or with a search already typed. */
export interface ViewDiscoverPayload extends ActionPayload {
    action: Action.ViewDiscover;
    /** Public Spaces or public rooms. Keeps the current section when omitted. */
    section?: DiscoverSection;
    /** Search text to start with. Keeps the current search when omitted. */
    query?: string;
}
