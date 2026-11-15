/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import type MatrixChat from "../../components/structures/MatrixChat";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { getScreenFromLocation, type IScreen, setInitialScreenAfterLogin } from "../routing";

/** Routes the desktop host builds from a matrix: link: a room (or an event in it), or a user. */
const LINK_ROUTE = /^#\/(?:room\/(?:%23|!|%21)|user\/%40)[^\s#]*$/;
const MAX_HASH_LENGTH = 4096;

/**
 * Reads the route of a Matrix link sent by the desktop host, keeping only what navigating needs.
 * @returns the screen to show, or undefined when the route is not one a Matrix link opens.
 */
export function parseMatrixLinkHash(hash: unknown): IScreen | undefined {
    if (typeof hash !== "string" || hash.length > MAX_HASH_LENGTH || !LINK_ROUTE.test(hash)) return undefined;
    const { screen, params } = getScreenFromLocation(new URL(hash, "https://localhost/"));
    // Servers to join through are the only parameter a link may carry: nothing else reaches the app's screens.
    const via = [params.via].flat().filter((server): server is string => typeof server === "string");
    return { screen, params: via.length ? { via: via.length === 1 ? via[0] : via } : {} };
}

/**
 * Opens a Matrix link the desktop host received while the app was running: at once if the user is signed in,
 * otherwise after they sign in.
 */
export function openMatrixLink(hash: unknown, matrixChat: MatrixChat | undefined = window.matrixChat): void {
    const screen = parseMatrixLinkHash(hash);
    if (!screen) {
        logger.warn("Ignoring a Matrix link the app cannot open");
        return;
    }
    if (matrixChat?.openScreenFromLink(screen)) return;
    // Signing in through the browser reloads the app, so a link for later must outlive this page as well.
    if (!matrixChat || !MatrixClientPeg.get()) setInitialScreenAfterLogin(screen);
}
