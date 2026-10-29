/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect } from "react";
import { DesktopCallStageView, I18nContext, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import type { ElementCall } from "../../../models/Call";
import { ModuleApi } from "../../../modules/Api";
import type { AetherCallPresentationBridge } from "./AetherCallPresentationTypes";
import { DesktopCallStageViewModel } from "../../../viewmodels/desktop/DesktopCallStageViewModel";

/** Existing Matrix client, persistent call, and live engine presentation bridge. */
export interface DesktopCallStageProps {
    readonly client: MatrixClient;
    readonly call: ElementCall;
    readonly bridge: AetherCallPresentationBridge;
}

/** Owns the desktop stage view model inside the persistent call presentation root. */
export function DesktopCallStage({ client, call, bridge }: DesktopCallStageProps): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(() => new DesktopCallStageViewModel({ client, call, bridge }));

    useEffect(() => {
        vm.setBridge(bridge);
    }, [vm, bridge]);

    return (
        <I18nContext.Provider value={window.mxModuleApi?.i18n ?? ModuleApi.instance.i18n}>
            <DesktopCallStageView vm={vm} />
        </I18nContext.Provider>
    );
}
