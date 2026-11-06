/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createContext } from "react";

import type PageType from "../PageTypes";

/** The page the logged-in view is showing, so the Space bar can mark Discover rather than a Space. */
export const PageTypeContext = createContext<PageType | string | undefined>(undefined);
