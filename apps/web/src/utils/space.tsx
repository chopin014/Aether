/*
Copyright 2024 New Vector Ltd.
Copyright 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { type Room, type ICreateRoomStateEvent, type RoomType, EventType, JoinRule } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";

import { calculateRoomVia } from "./permalinks/Permalinks";
import Modal from "../Modal";
import CreateRoomDialog from "../components/views/dialogs/CreateRoomDialog";
import createRoom from "../createRoom";
import { _t } from "../languageHandler";
import SpacePublicShare from "../components/views/spaces/SpacePublicShare";
import InfoDialog from "../components/views/dialogs/InfoDialog";
import { showRoomInviteDialog } from "../RoomInvite";
import CreateSubspaceDialog from "../components/views/dialogs/CreateSubspaceDialog";
import AddExistingSubspaceDialog from "../components/views/dialogs/AddExistingSubspaceDialog";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import Spinner from "../components/views/elements/Spinner";
import { shouldShowComponent } from "../customisations/helpers/UIComponents";
import { UIComponent } from "../settings/UIFeature";
import {
    type OpenSpacePreferencesPayload,
    type SpacePreferenceTab,
} from "../dispatcher/payloads/OpenSpacePreferencesPayload";
import { type OpenSpaceSettingsPayload } from "../dispatcher/payloads/OpenSpaceSettingsPayload";
import { type OpenAddExistingToSpaceDialogPayload } from "../dispatcher/payloads/OpenAddExistingToSpaceDialogPayload";
import { SDKContextClass } from "../contexts/SDKContextClass";

export const shouldShowSpaceSettings = (space: Room): boolean => {
    const userId = space.client.getUserId()!;
    return (
        space.getMyMembership() === KnownMembership.Join &&
        (space.currentState.maySendStateEvent(EventType.RoomAvatar, userId) ||
            space.currentState.maySendStateEvent(EventType.RoomName, userId) ||
            space.currentState.maySendStateEvent(EventType.RoomTopic, userId) ||
            space.currentState.maySendStateEvent(EventType.RoomJoinRules, userId))
    );
};

export const makeSpaceParentEvent = (room: Room, canonical = false): ICreateRoomStateEvent => ({
    type: EventType.SpaceParent,
    content: {
        via: calculateRoomVia(room),
        canonical: canonical,
    },
    state_key: room.roomId,
});

export function showSpaceSettings(space: Room): void {
    defaultDispatcher.dispatch<OpenSpaceSettingsPayload>({
        action: Action.OpenSpaceSettings,
        space,
    });
}

export const showAddExistingRooms = (space: Room): void => {
    defaultDispatcher.dispatch<OpenAddExistingToSpaceDialogPayload>({
        action: Action.OpenAddToExistingSpaceDialog,
        space,
    });
};

/**
 * Where a new room is listed in the room list, when created from one of its sections.
 */
export interface CreateNewRoomSection {
    /** The section tag to give the new room, so that it is listed in the section it was created from. */
    sectionTag?: string;
    /** The section's name, shown in the dialog. */
    sectionName?: string;
}

export const showCreateNewRoom = async (
    space: Room,
    type?: RoomType,
    { sectionTag, sectionName }: CreateNewRoomSection = {},
): Promise<boolean> => {
    const modal = Modal.createDialog(CreateRoomDialog, {
        type,
        defaultPublic: space.getJoinRule() === JoinRule.Public,
        parentSpace: space,
        sectionName,
    });
    const [shouldCreate, opts] = await modal.finished;
    if (shouldCreate) {
        const roomId = await createRoom(space.client, opts!);
        if (roomId && sectionTag) {
            // The room exists by now, so failing to file it only leaves it in its default section.
            await space.client
                .setRoomTag(roomId, sectionTag, {})
                .catch((error) => logger.warn(`Failed to add ${roomId} to section ${sectionTag}`, error));
        }
    }
    return !!shouldCreate;
};

export const shouldShowSpaceInvite = (space: Room): boolean =>
    ((space?.getMyMembership() === KnownMembership.Join && space.canInvite(space.client.getUserId()!)) ||
        space.getJoinRule() === JoinRule.Public) &&
    shouldShowComponent(UIComponent.InviteUsers);

export const showSpaceInvite = (space: Room, initialText = ""): void => {
    if (space.getJoinRule() === "public") {
        const modal = Modal.createDialog(InfoDialog, {
            title: _t("invite|to_space", { spaceName: space.name }),
            description: (
                <React.Fragment>
                    <span>{_t("space|share_public")}</span>
                    <SpacePublicShare space={space} onFinished={() => modal.close()} />
                </React.Fragment>
            ),
            fixedWidth: false,
            button: false,
            className: "mx_SpacePanel_sharePublicSpace",
            hasCloseButton: true,
        });
    } else {
        showRoomInviteDialog(space.roomId, initialText);
    }
};

export const showAddExistingSubspace = (space: Room): void => {
    const { finished } = Modal.createDialog(
        AddExistingSubspaceDialog,
        {
            space,
            onCreateSubspaceClick: () => showCreateNewSubspace(space),
        },
        "mx_AddExistingToSpaceDialog_wrapper",
    );
    void finished.then(([added]) => {
        if (added && SDKContextClass.instance.roomViewStore.getRoomId() === space.roomId) {
            defaultDispatcher.fire(Action.UpdateSpaceHierarchy);
        }
    });
};

export const showCreateNewSubspace = (space: Room): void => {
    const { finished } = Modal.createDialog(
        CreateSubspaceDialog,
        {
            space,
            onAddExistingSpaceClick: () => showAddExistingSubspace(space),
        },
        "mx_CreateSubspaceDialog_wrapper",
    );
    void finished.then(([added]) => {
        if (added && SDKContextClass.instance.roomViewStore.getRoomId() === space.roomId) {
            defaultDispatcher.fire(Action.UpdateSpaceHierarchy);
        }
    });
};

export const bulkSpaceBehaviour = async (
    space: Room,
    children: Room[],
    fn: (room: Room) => Promise<unknown>,
): Promise<void> => {
    const modal = Modal.createDialog(Spinner, undefined, "mx_Dialog_spinner");
    try {
        for (const room of children) {
            await fn(room);
        }
        await fn(space);
    } finally {
        modal.close();
    }
};

export const showSpacePreferences = (space: Room, initialTabId?: SpacePreferenceTab): void => {
    defaultDispatcher.dispatch<OpenSpacePreferencesPayload>({
        action: Action.OpenSpacePreferences,
        space,
        initialTabId,
    });
};
