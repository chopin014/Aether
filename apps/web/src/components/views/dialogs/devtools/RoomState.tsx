/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.
Copyright 2022 Michael Telatynski <7t3chguy@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type ChangeEventHandler, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type IContent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import classNames from "classnames";
import { Form, SettingsToggleInput } from "@vector-im/compound-web";

import { _t, _td } from "../../../../languageHandler";
import BaseTool, { DevtoolsContext, type IDevtoolsProps } from "./BaseTool";
import MatrixClientContext from "../../../../contexts/MatrixClientContext";
import { EventEditor, EventViewer, eventTypeField, stateKeyField, type IEditorProps, stringify } from "./Event";
import FilteredList from "./FilteredList";
import Spinner from "../../elements/Spinner";
import SyntaxHighlight from "../../elements/SyntaxHighlight";
import { useAsyncMemo } from "../../../../hooks/useAsyncMemo";
import { SlidingSyncManager } from "../../../../SlidingSyncManager";

/** A room's state events by event type, then state key. */
type RoomStateEvents = ReadonlyMap<string, ReadonlyMap<string, MatrixEvent>>;

/**
 * Fetch all of a room's current state from the server. Encrypted state events are decrypted; one that cannot be is
 * listed under the type and state key it was sent with.
 */
async function fetchRoomState(cli: MatrixClient, roomId: string): Promise<RoomStateEvents> {
    const mapper = cli.getEventMapper();
    const events = (await cli.roomState(roomId)).map((event) => mapper(event));
    await Promise.all(events.filter((event) => event.isEncrypted()).map((event) => cli.decryptEventIfNeeded(event)));
    const byType = new Map<string, Map<string, MatrixEvent>>();
    for (const event of events) {
        const failed = event.isDecryptionFailure();
        const type = failed ? event.getWireType() : event.getType();
        const stateKey = (failed ? event.getWireStateKey() : event.getStateKey()) ?? "";
        if (!byType.has(type)) byType.set(type, new Map());
        byType.get(type)!.set(stateKey, event);
    }
    return byType;
}

/**
 * The room's state to explore. Sliding sync loads only the state the app reads, so then all of it is fetched from the
 * server, and there is none to show until it arrives.
 * @returns The state, undefined while it is fetched, and whether it is only what this device has loaded because the
 *     fetch failed.
 */
function useRoomStateToExplore(): { events?: RoomStateEvents; loadedOnly: boolean } {
    const context = useContext(DevtoolsContext);
    const cli = useContext(MatrixClientContext);
    const fromServer = SlidingSyncManager.instance.isActiveFor(cli);
    const fetched = useAsyncMemo<RoomStateEvents | null | undefined>(async () => {
        if (!fromServer) return undefined;
        try {
            return await fetchRoomState(cli, context.room.roomId);
        } catch (error) {
            logger.warn("Devtools could not fetch the room's state", error);
            return null;
        }
    }, [cli, context.room, fromServer]);
    if (!fromServer || fetched === null) return { events: context.room.currentState.events, loadedOnly: fromServer };
    return { events: fetched, loadedOnly: false };
}

const NO_EVENTS: ReadonlyMap<string, MatrixEvent> = new Map();

export const StateEventEditor: React.FC<IEditorProps> = ({ mxEvent, onBack }) => {
    const context = useContext(DevtoolsContext);
    const cli = useContext(MatrixClientContext);

    const fields = useMemo(
        () => [eventTypeField(mxEvent?.getType()), stateKeyField(mxEvent?.getStateKey())],
        [mxEvent],
    );

    const onSend = async ([eventType, stateKey]: string[], content: IContent): Promise<void> => {
        await cli.sendStateEvent(context.room.roomId, eventType as any, content, stateKey);
    };

    const defaultContent = mxEvent ? stringify(mxEvent.getContent()) : undefined;
    return <EventEditor fieldDefs={fields} defaultContent={defaultContent} onSend={onSend} onBack={onBack} />;
};

interface StateEventButtonProps {
    label: string;
    onClick(this: void): void;
}

const RoomStateHistory: React.FC<{
    mxEvent: MatrixEvent;
    onBack(this: void): void;
}> = ({ mxEvent, onBack }) => {
    const cli = useContext(MatrixClientContext);
    const events = useAsyncMemo(
        async () => {
            const events = [mxEvent.event];
            while (!!events[0].unsigned?.replaces_state) {
                try {
                    events.unshift(await cli.fetchRoomEvent(mxEvent.getRoomId()!, events[0].unsigned.replaces_state));
                } catch (e) {
                    events.unshift({
                        event_id: events[0].unsigned.replaces_state,
                        unsigned: {
                            error: e instanceof Error ? e.message : String(e),
                        },
                    });
                }
            }
            return events;
        },
        [cli, mxEvent],
        null,
    );

    let body = <Spinner />;
    if (events !== null) {
        body = (
            <>
                {events.map((ev) => (
                    <SyntaxHighlight language="json" key={ev.event_id}>
                        {stringify(ev)}
                    </SyntaxHighlight>
                ))}
            </>
        );
    }

    return <BaseTool onBack={onBack}>{body}</BaseTool>;
};

const StateEventButton: React.FC<StateEventButtonProps> = ({ label, onClick }) => {
    const trimmed = label.trim();

    let content = label;
    if (!trimmed) {
        content = label.length > 0 ? _t("devtools|spaces", { count: label.length }) : _t("devtools|empty_string");
    }

    return (
        <button
            className={classNames("mx_LegacyDialogButton mx_DevTools_button", {
                mx_DevTools_RoomStateExplorer_button_hasSpaces: trimmed.length !== label.length,
                mx_DevTools_RoomStateExplorer_button_emptyString: !trimmed,
            })}
            onClick={onClick}
            type="button"
        >
            {content}
        </button>
    );
};

interface IEventTypeProps extends Pick<IDevtoolsProps, "onBack"> {
    /** The room's state events of one type, by state key. */
    events: ReadonlyMap<string, MatrixEvent>;
}

const RoomStateExplorerEventType: React.FC<IEventTypeProps> = ({ events, onBack }) => {
    const [query, setQuery] = useState("");
    const [event, setEvent] = useState<MatrixEvent | null>(null);
    const [history, setHistory] = useState(false);
    const [showEmptyState, setShowEmptyState] = useState(true);
    const onEmptyStateToggled = useCallback<ChangeEventHandler<HTMLInputElement>>(
        (e) => setShowEmptyState(e.target.checked),
        [setShowEmptyState],
    );

    useEffect(() => {
        if (events.size === 1 && events.has("")) {
            setEvent(events.get("")!);
        } else {
            setEvent(null);
        }
    }, [events]);

    if (event && history) {
        const _onBack = (): void => {
            setHistory(false);
        };
        return <RoomStateHistory mxEvent={event} onBack={_onBack} />;
    }
    if (event) {
        const _onBack = (): void => {
            if (events?.size === 1 && events.has("")) {
                onBack();
            } else {
                setEvent(null);
            }
        };
        const onHistoryClick = (): void => {
            setHistory(true);
        };
        const extraButton = (
            <button onClick={onHistoryClick} className="mx_LegacyDialogButton" type="button">
                {_t("devtools|see_history")}
            </button>
        );
        return <EventViewer mxEvent={event} onBack={_onBack} Editor={StateEventEditor} extraButton={extraButton} />;
    }

    return (
        <BaseTool onBack={onBack}>
            <FilteredList query={query} onChange={setQuery}>
                {Array.from(events.entries())
                    .filter(([_, ev]) => showEmptyState || Object.keys(ev.getContent()).length > 0)
                    .map(([stateKey, ev]) => (
                        <StateEventButton key={stateKey} label={stateKey} onClick={() => setEvent(ev)} />
                    ))}
            </FilteredList>
            <Form.Root
                onSubmit={(evt) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                }}
            >
                <SettingsToggleInput
                    name="empty_state_toggle"
                    label={_t("devtools|show_empty_content_events")}
                    onChange={onEmptyStateToggled}
                    checked={showEmptyState}
                />
            </Form.Root>
        </BaseTool>
    );
};

export const RoomStateExplorer: React.FC<IDevtoolsProps> = ({ onBack, setTool }) => {
    const [query, setQuery] = useState("");
    const [eventType, setEventType] = useState<string | null>(null);

    const { events, loadedOnly } = useRoomStateToExplore();

    if (events && eventType !== null) {
        const onBack = (): void => {
            setEventType(null);
        };
        return <RoomStateExplorerEventType events={events.get(eventType) ?? NO_EVENTS} onBack={onBack} />;
    }

    const onAction = async (): Promise<void> => {
        setTool(_td("devtools|send_custom_state_event"), StateEventEditor);
    };

    return (
        <BaseTool onBack={onBack} actionLabel={_td("devtools|send_custom_state_event")} onAction={onAction}>
            {events ? (
                <>
                    {loadedOnly && <p>{_t("devtools|room_state_loaded_only")}</p>}
                    <FilteredList query={query} onChange={setQuery}>
                        {Array.from(events.keys()).map((eventType) => (
                            <StateEventButton
                                key={eventType}
                                label={eventType}
                                onClick={() => setEventType(eventType)}
                            />
                        ))}
                    </FilteredList>
                </>
            ) : (
                <Spinner />
            )}
        </BaseTool>
    );
};
