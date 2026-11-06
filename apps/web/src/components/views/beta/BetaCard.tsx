/*
Copyright 2024 New Vector Ltd.
Copyright 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import { _t } from "../../../languageHandler";

/** A small "Beta" label shown next to features that are still in beta. */
export const BetaPill: React.FC = () => <span className="mx_BetaCard_betaPill">{_t("common|beta")}</span>;
