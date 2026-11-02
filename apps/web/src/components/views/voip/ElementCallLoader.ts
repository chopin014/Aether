/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type * as ElementCallComponent from "@element-hq/element-call-component";

import { ElementCall } from "../../../models/Call";
import { CallStore } from "../../../stores/CallStore";

let loaded: Promise<{ default: typeof ElementCallComponent.ElementCall }> | undefined;

/** Share initialization between background preparation and the first call, retrying failed downloads. */
export function loadElementCallComponent(): Promise<{ default: typeof ElementCallComponent.ElementCall }> {
    loaded ??= Promise.all([
        import(/* webpackChunkName: "element-call-component" */ "@element-hq/element-call-component"),
        import(/* webpackChunkName: "element-call-component" */ "./ElementCallComponent.css"),
    ])
        .then(async ([module]) => {
            await module.initializeElementCall(
                ElementCall.getConfigOptions(CallStore.instance.getConfiguredRTCTransports()),
            );
            return { default: module.ElementCall };
        })
        .catch((error: unknown) => {
            loaded = undefined;
            throw error;
        });
    return loaded;
}
