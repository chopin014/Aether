/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** A Space or child `order` if it is valid, as the spec defines it. */
export const validOrder = (order?: string): string | undefined => {
    if (
        typeof order === "string" &&
        order.length <= 50 &&
        Array.from(order).every((c: string) => {
            const charCode = c.charCodeAt(0);
            return charCode >= 0x20 && charCode <= 0x7e;
        })
    ) {
        return order;
    }
};

/** A key for sorting a Space's children by their validated `order`, then `origin_server_ts`, then room ID. */
export const getChildOrder = (order: string | undefined, ts: number, roomId: string): Array<string | number> => {
    return [validOrder(order) ?? NaN, ts, roomId]; // NaN has lodash sort it at the end in asc
};
