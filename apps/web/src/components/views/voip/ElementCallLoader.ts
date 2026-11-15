/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type * as ElementCallComponent from "@element-hq/element-call-component";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import { ElementCall } from "../../../models/Call";
import { elementCallOpenIdTokens } from "./ElementCallOpenIdToken";
import { callServiceUrlFor } from "./ElementCallService";

type ElementCallModule = typeof ElementCallComponent;

let loaded: Promise<ElementCallModule> | undefined;

/** The initialized module, shared between background preparation and the first call, retrying failed downloads. */
function loadElementCallModule(): Promise<ElementCallModule> {
    loaded ??= Promise.all([
        import(/* webpackChunkName: "element-call-component" */ "@element-hq/element-call-component"),
        import(/* webpackChunkName: "element-call-component" */ "./ElementCallComponent.css"),
    ])
        .then(async ([module]) => {
            // The call service is asked of the joining account, not fixed here for the first account to load this.
            module.setElementCallServiceUrl(callServiceUrlFor);
            module.setElementCallOpenIdTokens(elementCallOpenIdTokens);
            await module.initializeElementCall(ElementCall.getConfigOptions());
            return module;
        })
        .catch((error: unknown) => {
            loaded = undefined;
            throw error;
        });
    return loaded;
}

let component: Promise<{ default: typeof ElementCallComponent.ElementCall }> | undefined;
let loadedComponent: typeof ElementCallComponent.ElementCall | undefined;

/**
 * The component once loaded and initialized, so that a call can render it directly. Rendering it through `lazy`
 * suspends even when it is already loaded, and React then holds the call back for a few hundred milliseconds.
 */
export function getLoadedElementCallComponent(): typeof ElementCallComponent.ElementCall | undefined {
    return loadedComponent;
}

/** Share initialization between background preparation and the first call, retrying failed downloads. */
export function loadElementCallComponent(): Promise<{ default: typeof ElementCallComponent.ElementCall }> {
    component ??= loadElementCallModule().then(
        (module) => {
            loadedComponent = module.ElementCall;
            return { default: module.ElementCall };
        },
        (error: unknown) => {
            component = undefined;
            throw error;
        },
    );
    return component;
}

/**
 * Fetches the call service token the user would join a room's call with, so that joining it soon does not wait for
 * one. Element Call keeps it until shortly before it expires, and asking again meanwhile costs nothing.
 *
 * @param client - The account that would join.
 * @param roomId - The room whose call it would join.
 */
export async function prefetchElementCallTransport(client: MatrixClient, roomId: string): Promise<void> {
    const module = await loadElementCallModule();
    await module.prefetchElementCallTransport(client, roomId);
}
