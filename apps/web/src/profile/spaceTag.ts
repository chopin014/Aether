/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { isHexColour, type DesktopProfileTag } from "@element-hq/web-shared-components";

import { type RichProfile } from "./richProfile";

/** State event in a Space defining the tag its members can wear. This is not part of the Matrix specification. */
export const SPACE_TAG_EVENT_TYPE = "io.aether.space.tag";

/** Discord's server tags are 4 characters, which is what keeps them from competing with the name beside them. */
export const MAX_SPACE_TAG_LENGTH = 4;

/** A Space's tag definition. */
export interface SpaceTag {
    label: string;
    emoji?: string;
    colour?: string;
}

/** Read a Space's tag definition, or undefined if it has none or it is malformed. */
export function parseSpaceTag(content: Record<string, unknown> | undefined): SpaceTag | undefined {
    if (typeof content?.label !== "string") return undefined;
    const label = [...new Intl.Segmenter().segment(content.label.trim())]
        .slice(0, MAX_SPACE_TAG_LENGTH)
        .map(({ segment }) => segment)
        .join("");
    if (!label) return undefined;
    const emoji =
        typeof content.emoji === "string" && content.emoji
            ? [...new Intl.Segmenter().segment(content.emoji)][0]?.segment
            : undefined;
    return { label, emoji, colour: isHexColour(content.colour) ? content.colour : undefined };
}

/** The tag a Space defines, read from its own state. */
export function getSpaceTag(room: Room): SpaceTag | undefined {
    return parseSpaceTag(room.currentState.getStateEvents(SPACE_TAG_EVENT_TYPE, "")?.getContent());
}

/** Spaces the user has joined that offer a tag to wear. */
export function spaceTagOptions(client: MatrixClient): (DesktopProfileTag & { spaceId: string })[] {
    return client
        .getRooms()
        .filter((room) => room.isSpaceRoom() && room.getMyMembership() === KnownMembership.Join)
        .flatMap((room) => {
            const tag = getSpaceTag(room);
            return tag ? [{ ...tag, spaceId: room.roomId, spaceName: room.name }] : [];
        })
        .sort((a, b) => a.spaceName.localeCompare(b.spaceName));
}

/**
 * The tag to show for someone. A profile can only name a Space; the label comes from that Space's own state, and the
 * person must really be joined to it, so nobody can invent a tag or claim one from a community they are not in. This
 * also means a tag only shows to people who share that Space, whose state this client can read.
 */
export function wornSpaceTag(
    client: MatrixClient,
    profile: RichProfile,
    userId: string,
): DesktopProfileTag | undefined {
    if (!profile.tagSpaceId) return undefined;
    const space = client.getRoom(profile.tagSpaceId);
    if (!space?.isSpaceRoom() || space.getMember(userId)?.membership !== KnownMembership.Join) return undefined;
    const tag = getSpaceTag(space);
    return tag && { ...tag, spaceName: space.name };
}
