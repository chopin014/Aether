/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    Disposables,
    type DesktopThreadBrowserSnapshot,
    type DesktopThreadBrowserActions,
} from "@element-hq/web-shared-components";
import {
    EventTimeline,
    EventType,
    MatrixEventEvent,
    RoomEvent,
    RoomStateEvent,
    ThreadEvent,
    type EventTimelineSet,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";

import { threadLabel } from "./threadLabel";
import { getCurrentLanguage } from "../../languageHandler";

interface Props {
    client: MatrixClient;
    room: Room;
    onOpen: (root: MatrixEvent) => void;
    onCreate: () => void;
}

/** Discovers real SDK threads, retaining server pagination and live content changes. */
export class DesktopThreadBrowserViewModel
    extends BaseViewModel<DesktopThreadBrowserSnapshot, Props>
    implements DesktopThreadBrowserActions
{
    private contentListeners = new Disposables();
    private initialized = false;
    private request = 0;

    public constructor(props: Props) {
        super(props, {
            query: "",
            filter: "all",
            rows: [],
            loading: false,
            error: false,
            hasMore: false,
            canCreate: false,
        });
        for (const event of [
            ThreadEvent.New,
            ThreadEvent.Update,
            ThreadEvent.Delete,
            RoomEvent.Timeline,
            RoomEvent.Receipt,
            RoomEvent.Redaction,
            RoomEvent.MyMembership,
            RoomEvent.LocalEchoUpdated,
        ]) {
            this.disposables.trackListener(props.room, event, this.refresh);
        }
        this.disposables.trackListener(props.room.currentState, RoomStateEvent.Events, this.refresh);
        this.disposables.track(() => this.contentListeners.dispose());
        this.refresh();
        void this.retry();
    }

    public setQuery = (query: string): void => {
        this.snapshot.merge({ query });
        this.refresh();
    };

    public setFilter = (filter: "all" | "mine"): void => {
        if (filter === this.getSnapshot().filter) return;
        if (this.initialized) ++this.request;
        this.snapshot.merge({ filter, ...(this.initialized ? { loading: false, error: false } : {}) });
        this.refresh();
    };

    public createThread = (): void => {
        if (this.getSnapshot().canCreate) this.props.onCreate();
    };

    public openThread = (id: string): void => {
        const root = this.props.room.getThread(id)?.rootEvent ?? this.timelineSet?.findEventById(id);
        if (root) this.props.onOpen(root);
    };

    private get timelineSet(): EventTimelineSet | undefined {
        return this.props.room.threadsTimelineSets[this.getSnapshot().filter === "all" ? 0 : 1];
    }

    public retry = async (): Promise<void> => {
        if (this.getSnapshot().loading || this.isDisposed) return;
        if (this.initialized) return this.loadMore();
        const request = ++this.request;
        this.snapshot.merge({ loading: true, error: false });
        try {
            const sets = await this.props.room.createThreadsTimelineSets();
            if (!sets) throw new Error("Thread timeline sets unavailable");
            await this.props.room.fetchRoomThreads();
            if (this.isDisposed || request !== this.request) return;
            for (const set of sets) this.disposables.trackListener(set, RoomEvent.Timeline, this.refresh);
            this.initialized = true;
            this.refresh();
        } catch {
            if (!this.isDisposed && request === this.request) this.snapshot.merge({ error: true });
        } finally {
            if (!this.isDisposed && request === this.request) this.snapshot.merge({ loading: false });
        }
    };

    public loadMore = async (): Promise<void> => {
        const timelineSet = this.timelineSet;
        if (this.isDisposed || this.getSnapshot().loading || !timelineSet) return;
        const request = ++this.request;
        this.snapshot.merge({ loading: true, error: false });
        try {
            await this.props.client.paginateEventTimeline(timelineSet.getLiveTimeline(), {
                backwards: true,
                limit: 30,
            });
            if (!this.isDisposed && request === this.request) this.refresh();
        } catch {
            if (!this.isDisposed && request === this.request) this.snapshot.merge({ error: true });
        } finally {
            if (!this.isDisposed && request === this.request) this.snapshot.merge({ loading: false });
        }
    };

    private onContentChanged = (): void => {
        queueMicrotask(this.refresh);
    };

    private refresh = (): void => {
        if (this.isDisposed) return;
        this.contentListeners.dispose();
        this.contentListeners = new Disposables();
        const { room, client } = this.props;
        const { query, filter } = this.getSnapshot();
        const roots = new Map<string, MatrixEvent>();
        for (const root of this.timelineSet?.getLiveTimeline().getEvents() ?? []) {
            if (root.getId()) roots.set(root.getId()!, root);
        }
        for (const thread of room.getThreads()) {
            if (thread.rootEvent && thread.length && (filter === "all" || thread.hasCurrentUserParticipated)) {
                roots.set(thread.id, thread.rootEvent);
            }
        }
        const watch = (event: MatrixEvent): void => {
            for (const name of [
                MatrixEventEvent.Decrypted,
                MatrixEventEvent.Replaced,
                MatrixEventEvent.BeforeRedaction,
            ]) {
                this.contentListeners.trackListener(event, name, this.onContentChanged);
            }
            if (event.isEncrypted() && !event.isDecryptionFailure() && !event.getClearContent()) {
                void client.decryptEventIfNeeded(event).catch(() => undefined);
            }
        };
        const rows = [...roots]
            .map(([id, root]) => {
                watch(root);
                const thread = room.getThread(id);
                const latest = thread?.replyToEvent;
                if (latest && latest !== root) watch(latest);
                const title = threadLabel(root);
                const preview = latest && latest !== root ? threadLabel(latest) : "";
                const timestamp = latest?.getTs() ?? root.getTs();
                return {
                    id,
                    title,
                    preview,
                    timestamp,
                    replies: thread?.length ?? 0,
                    activity: new Intl.DateTimeFormat(getCurrentLanguage().replaceAll("_", "-"), {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                    }).format(timestamp),
                    unread:
                        !!thread &&
                        !!latest?.getId() &&
                        !!client.getUserId() &&
                        !thread?.hasUserReadEvent(client.getUserId()!, latest.getId()!),
                };
            })
            .filter((row) => `${row.title} ${row.preview}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .sort((a, b) => b.timestamp - a.timestamp);
        this.snapshot.merge({
            rows,
            hasMore: !!this.timelineSet?.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS),
            canCreate:
                room.getMyMembership() === "join" &&
                room.currentState.maySendEvent(EventType.RoomMessage, client.getUserId()!),
        });
    };
}
