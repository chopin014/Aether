/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type PinnedMessagesViewSnapshot,
    type PinnedMessagesViewModel as Contract,
} from "@element-hq/web-shared-components";
import {
    EventTimeline,
    EventType,
    RoomStateEvent,
    RoomEvent,
    MatrixEventEvent,
    RelationType,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    type IRoomTimelineData,
} from "matrix-js-sdk/src/matrix";

import { fetchPinnedEvent } from "../../hooks/usePinnedEvents";
import PinningUtils from "../../utils/PinningUtils";
import { batch } from "../../utils/promise";
import { formatFullDate } from "../../DateUtils";
import { ReadPinsEventId } from "../../components/views/right_panel/types";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";

/** Matrix dependencies and dismissal callback for the pinned-message browser. */
interface Props {
    room: Room;
    client: MatrixClient;
    onClose(): void;
}

/** Loads pins through Element's existing Matrix paths and keeps their permissions current. */
export class PinnedMessagesViewModel extends BaseViewModel<PinnedMessagesViewSnapshot, Props> implements Contract {
    private events = new Map<string, MatrixEvent>();
    private pendingEdits = new Map<string, MatrixEvent[]>();
    private ids: string[] = [];
    private generation = 0;
    private unpinning = new Set<string>();
    private eventCleanups: (() => void)[] = [];
    private failedUnpin?: string;

    public constructor(props: Props) {
        super(props, { items: [], loading: true, error: null });
        const state = props.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        if (state) this.disposables.trackListener(state, RoomStateEvent.Update, this.onState);
        this.disposables.trackListener(props.room, RoomEvent.Timeline, this.onTimeline);
        this.disposables.trackListener(props.room, RoomEvent.Redaction, this.onRedaction);
        this.disposables.track(() => this.clearEventListeners());
        this.retry();
    }

    private getIds = (): string[] => {
        const ids: unknown = this.props.room
            .getLiveTimeline()
            .getState(EventTimeline.FORWARDS)
            ?.getStateEvents(EventType.RoomPinnedEvents, "")
            ?.getContent().pinned;
        return Array.isArray(ids)
            ? [...new Set(ids.filter((id): id is string => typeof id === "string"))].slice(0, 100)
            : [];
    };

    private onState = (): void => {
        if (JSON.stringify(this.getIds()) !== JSON.stringify(this.ids)) {
            this.failedUnpin = undefined;
            void this.load();
        } else this.refresh();
    };

    private onTimeline = (event: unknown, _room: unknown, _toStart: unknown, removed: unknown, data: unknown): void => {
        // Live edits can arrive without changing the pinned-event state.
        if (removed || !(data as IRoomTimelineData)?.liveEvent) return;
        const edit = event as MatrixEvent;
        const relation = edit.getRelation();
        if (relation?.rel_type !== RelationType.Replace || !relation.event_id || !this.ids.includes(relation.event_id))
            return;
        const original = this.events.get(relation.event_id);
        if (original) this.applyEdit(original, edit);
        else {
            const pending = this.pendingEdits.get(relation.event_id) ?? [];
            this.pendingEdits.set(relation.event_id, [...pending, edit]);
        }
    };

    private applyEdit = (original: MatrixEvent, edit: MatrixEvent): void => {
        if (original.getSender() !== edit.getSender() || original.getType() !== edit.getType()) return;
        if ((original.replacingEvent()?.getTs() ?? -Infinity) > edit.getTs()) return;
        original.makeReplaced(edit);
    };

    private onRedaction = (event: unknown): void => {
        const redaction = event as MatrixEvent;
        const id = redaction.getAssociatedId();
        const pinned = id && this.events.get(id);
        if (pinned && !pinned.isRedacted()) pinned.makeRedacted(redaction, this.props.room);
        this.refresh();
    };

    private clearEventListeners = (): void => {
        this.eventCleanups.splice(0).forEach((cleanup) => cleanup());
    };

    private refresh = (): void => {
        if (this.isDisposed) return;
        const canUnpin = PinningUtils.userHasPinOrUnpinPermission(this.props.client, this.props.room);
        this.snapshot.merge({
            items: this.ids
                .map((id) => {
                    const event = this.events.get(id);
                    const date = event && new Date(event.getTs());
                    return {
                        id,
                        author: event?.sender?.name || event?.getSender() || "",
                        datetime: date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined,
                        timestamp: date && Number.isFinite(date.getTime()) ? formatFullDate(date, false, false) : "",
                        unavailable: !event,
                        canUnpin,
                        unpinning: this.unpinning.size > 0,
                    };
                })
                .sort((a, b) => (b.datetime ?? "").localeCompare(a.datetime ?? "")),
        });
    };

    private load = async (): Promise<void> => {
        const generation = ++this.generation;
        this.ids = this.getIds();
        this.snapshot.merge({ items: [], loading: !!this.ids.length, error: null });
        this.events.clear();
        this.pendingEdits.clear();
        this.clearEventListeners();
        const ids = this.ids;
        const events = await batch(
            ids.map((id) => async () => {
                try {
                    return await fetchPinnedEvent(this.props.room, id, this.props.client);
                } catch {
                    return null;
                }
            }),
            10,
        );
        if (this.isDisposed || generation !== this.generation) return;
        events.forEach((event, index) => {
            if (!event) return;
            this.events.set(ids[index], event);
            for (const edit of this.pendingEdits.get(ids[index]) ?? []) this.applyEdit(event, edit);
            for (const name of [
                MatrixEventEvent.Replaced,
                MatrixEventEvent.Decrypted,
                MatrixEventEvent.BeforeRedaction,
            ]) {
                event.on(name, this.refresh);
                this.eventCleanups.push(() => event.off(name, this.refresh));
            }
        });
        this.pendingEdits.clear();
        this.snapshot.merge({ loading: false, error: events.some((event) => !event) ? "load" : null });
        this.refresh();
        if (!this.props.client.isGuest()) {
            // Read state is cosmetic: a rejected account-data write must not hide the loaded pins.
            void this.props.client
                .setRoomAccountData(this.props.room.roomId, ReadPinsEventId, { event_ids: ids })
                .catch(() => {});
        }
    };

    /** Retry a failed load or unpin operation. */
    public retry = (): void => {
        if (this.failedUnpin) void this.performUnpin(this.failedUnpin);
        else void this.load();
    };

    /** Resolve an event for Element's authenticated message and avatar renderers. */
    public getEvent = (id: string): MatrixEvent | undefined => this.events.get(id);

    /** Highlight the original event in its room, preserving thread routing in RoomView. */
    public jump = (id: string): void => {
        if (!this.events.has(id)) return;
        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: this.props.room.roomId,
            event_id: id,
            highlighted: true,
            metricsTrigger: undefined,
        });
        this.close();
    };

    private performUnpin = async (id: string): Promise<void> => {
        if (this.unpinning.size > 0 || this.isDisposed) return;
        this.unpinning.add(id);
        this.failedUnpin = undefined;
        this.snapshot.merge({ error: null });
        this.refresh();
        try {
            await PinningUtils.unpinEvent(this.props.client, this.props.room, id);
        } catch {
            this.failedUnpin = id;
            if (!this.isDisposed) this.snapshot.merge({ error: "unpin" });
        } finally {
            this.unpinning.delete(id);
            this.refresh();
        }
    };

    /** Remove a pin only if the current Matrix room state still permits it. */
    public unpin = (id: string): void => {
        void this.performUnpin(id);
    };

    /** Dismiss the browser. */
    public close = (): void => this.props.onClose();
}
