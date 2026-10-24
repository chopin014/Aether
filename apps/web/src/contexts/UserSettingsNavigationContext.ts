/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createContext } from "react";

import { type UserTab } from "../components/views/dialogs/UserTab";

/** Lets a page of the user settings send the dialog to another page, instead of stacking a second dialog. */
export const UserSettingsNavigationContext = createContext<(tab: UserTab) => void>(() => {});
UserSettingsNavigationContext.displayName = "UserSettingsNavigationContext";
