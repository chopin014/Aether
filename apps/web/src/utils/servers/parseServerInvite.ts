/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { parsePermalink } from "../permalinks/Permalinks";

/** Where an invite points. */
export interface ServerInvite {
    roomId?: string;
    roomAlias?: string;
    viaServers: string[];
}

const ALIAS = /^#[^:\s]+:\S+$/;
// Room IDs from room version 12 on are a bare hash with no server part, such as "!G3ja…Pb0".
const ROOM_ID = /^![^:\s]+(?::\S+)?$/;

/**
 * Read what someone pasted into "Join a server": a matrix.to or Aether link, an address such as #aether:matrix.org,
 * or an address without its leading #.
 *
 * @returns where the invite points, or null if it is not an invite.
 */
export function parseServerInvite(input: string): ServerInvite | null {
    const text = input.trim();
    if (!text) return null;

    let address = text;
    let viaServers: string[] = [];
    if (/^[a-z][a-z+.-]*:\/\/|^matrix:/i.test(text)) {
        const permalink = parsePermalink(text);
        if (!permalink?.roomIdOrAlias) return null;
        address = permalink.roomIdOrAlias;
        viaServers = permalink.viaServers ?? [];
    } else if (!/^[#!]/.test(address) && address.includes(":")) {
        address = `#${address}`;
    }

    if (ROOM_ID.test(address)) return { roomId: address, viaServers };
    if (ALIAS.test(address)) return { roomAlias: address, viaServers };
    return null;
}
