/*
Copyright 2024 New Vector Ltd.
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";
import { type Room, type MatrixEvent, RoomStateEvent } from "matrix-js-sdk/src/matrix";

import { _t } from "../../../../../languageHandler";
import BridgeTile from "../../BridgeTile";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import MatrixClientContext from "../../../../../contexts/MatrixClientContext";

const BRIDGE_EVENT_TYPES = [
    "uk.half-shot.bridge",
    // m.bridge
];

const BRIDGES_LINK = "https://matrix.org/bridges/";

interface IProps {
    room: Room;
}

interface IState {
    bridgeEvents: MatrixEvent[];
}

/** The bridges a room is part of, from its state. */
function bridgeEventsOf(room: Room): MatrixEvent[] {
    return BRIDGE_EVENT_TYPES.flatMap((typeName) => room.currentState.getStateEvents(typeName));
}

export default class BridgeSettingsTab extends React.Component<IProps, IState> {
    public static contextType = MatrixClientContext;
    declare public context: React.ContextType<typeof MatrixClientContext>;

    public constructor(props: IProps) {
        super(props);
        this.state = { bridgeEvents: bridgeEventsOf(props.room) };
    }

    public componentDidMount(): void {
        this.context.on(RoomStateEvent.Events, this.onStateEvent);
    }

    public componentWillUnmount(): void {
        this.context.removeListener(RoomStateEvent.Events, this.onStateEvent);
    }

    // Under sliding sync, a room nobody has opened gets its bridges after its settings open.
    private onStateEvent = (event: MatrixEvent): void => {
        if (event.getRoomId() === this.props.room.roomId && BRIDGE_EVENT_TYPES.includes(event.getType())) {
            this.setState({ bridgeEvents: bridgeEventsOf(this.props.room) });
        }
    };

    private renderBridgeCard(event: MatrixEvent, room: Room | null): ReactNode {
        const content = event.getContent();
        if (!room || !content?.channel || !content.protocol) return null;
        return <BridgeTile key={event.getId()} room={room} ev={event} />;
    }

    public render(): React.ReactNode {
        const { bridgeEvents } = this.state;
        const room = this.props.room;

        let content: JSX.Element;
        if (bridgeEvents.length > 0) {
            content = (
                <div>
                    <p>
                        {_t(
                            "room_settings|bridges|description",
                            {},
                            {
                                // TODO: We don't have this link yet: this will prevent the translators
                                // having to re-translate the string when we do.
                                a: (sub) => (
                                    <a href={BRIDGES_LINK} target="_blank" rel="noreferrer noopener">
                                        {sub}
                                    </a>
                                ),
                            },
                        )}
                    </p>
                    <ul className="mx_RoomSettingsDialog_BridgeList">
                        {bridgeEvents.map((event) => this.renderBridgeCard(event, room))}
                    </ul>
                </div>
            );
        } else {
            content = (
                <p>
                    {_t(
                        "room_settings|bridges|empty",
                        {},
                        {
                            // TODO: We don't have this link yet: this will prevent the translators
                            // having to re-translate the string when we do.
                            a: (sub) => (
                                <a href={BRIDGES_LINK} target="_blank" rel="noreferrer noopener">
                                    {sub}
                                </a>
                            ),
                        },
                    )}
                </p>
            );
        }

        return (
            <SettingsTab>
                <SettingsSection heading={_t("room_settings|bridges|title")}>{content}</SettingsSection>
            </SettingsTab>
        );
    }
}
