/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type ChangeEvent, type JSX, useState } from "react";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { DesktopProfileTagChip, isHexColour } from "@element-hq/web-shared-components";

import { _t } from "../../../languageHandler";
import AccessibleButton from "../elements/AccessibleButton";
import Field from "../elements/Field";
import { SettingsSubsection } from "../settings/shared/SettingsSubsection";
import { getSpaceTag, MAX_SPACE_TAG_LENGTH, parseSpaceTag, SPACE_TAG_EVENT_TYPE } from "../../../profile/spaceTag";
import { useFeatureEnabled } from "../../../hooks/useSettings";

interface Props {
    matrixClient: MatrixClient;
    space: Room;
}

/** Lets a Space's administrators define the short tag its members can choose to wear beside their name. */
export function SpaceTagSettings({ matrixClient: client, space }: Props): JSX.Element | null {
    const desktopShell = useFeatureEnabled("feature_desktop_shell");
    const current = getSpaceTag(space);
    const [label, setLabel] = useState(current?.label ?? "");
    const [emoji, setEmoji] = useState(current?.emoji ?? "");
    const [colour, setColour] = useState(current?.colour ?? "#7b5cff");
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    if (!desktopShell) return null;
    const canEdit = space.currentState.maySendStateEvent(SPACE_TAG_EVENT_TYPE, client.getSafeUserId());
    if (!canEdit && !current) return null;

    const draft = parseSpaceTag({ label, emoji, colour: isHexColour(colour) ? colour : undefined });

    const send = async (content: Record<string, unknown>): Promise<void> => {
        setBusy(true);
        setFailed(false);
        try {
            await client.sendStateEvent(space.roomId, SPACE_TAG_EVENT_TYPE as never, content as never, "");
        } catch (error) {
            logger.warn("Could not save the Space tag", error);
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <SettingsSubsection
            heading={_t("room_settings|general|space_tag")}
            description={_t("room_settings|general|space_tag_description")}
        >
            <Field
                label={_t("room_settings|general|space_tag_label")}
                value={label}
                maxLength={MAX_SPACE_TAG_LENGTH}
                disabled={!canEdit || busy}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setLabel(event.target.value)}
            />
            <Field
                label={_t("room_settings|general|space_tag_emoji")}
                value={emoji}
                maxLength={16}
                disabled={!canEdit || busy}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setEmoji(event.target.value)}
            />
            <Field
                type="color"
                label={_t("room_settings|general|space_tag_colour")}
                value={colour}
                disabled={!canEdit || busy}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setColour(event.target.value)}
            />
            {draft && <DesktopProfileTagChip tag={{ ...draft, spaceName: space.name }} />}
            {failed && <div className="mx_SpaceRoomView_errorText">{_t("room_settings|general|space_tag_error")}</div>}
            {canEdit && (
                <div>
                    <AccessibleButton
                        kind="primary"
                        disabled={busy || !draft}
                        onClick={() => draft && send({ ...draft })}
                    >
                        {_t("action|save")}
                    </AccessibleButton>
                    {current && (
                        <AccessibleButton
                            kind="link"
                            disabled={busy}
                            onClick={() => {
                                setLabel("");
                                void send({});
                            }}
                        >
                            {_t("action|remove")}
                        </AccessibleButton>
                    )}
                </div>
            )}
        </SettingsSubsection>
    );
}
