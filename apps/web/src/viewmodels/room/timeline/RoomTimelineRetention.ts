/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { Disposables } from "@element-hq/web-shared-components";
import {
    ClientEvent,
    EventType,
    MatrixEventEvent,
    RoomEvent,
    RoomStateEvent,
    SyncState,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import SettingsStore from "../../../settings/SettingsStore";
import { ModuleApi } from "../../../modules/Api";

/**
 * Evidence that a small, plain-text timeline model has not changed while parked. This is not permission to retain
 * mounted EventTiles: their independent effects and security presentation must still be destroyed and recreated.
 * A missed notification, unsupported graph, sync discontinuity or changed mutable content rejects reuse.
 */
export class RoomTimelineRetention {
    /** Model-only bounds; these do not claim a bound on the SDK's shared room cache or browser memory. */
    public static readonly maxEvents = 80;
    public static readonly maxAgeMs = 60_000;
    private readonly disposables = new Disposables();
    private readonly capturedAt = Date.now();
    private readonly live;
    private readonly state;
    private readonly crypto;
    private signature: string | null;

    public constructor(
        private readonly client: MatrixClient,
        private readonly room: Room,
        private readonly events: readonly MatrixEvent[],
    ) {
        this.live = room.getLiveTimeline();
        this.state = room.currentState;
        this.crypto = client.getCrypto();
        this.signature = this.readSignature();
        if (this.signature === null) return;

        const invalidate = (): void => {
            this.signature = null;
            this.disposables.dispose();
        };
        // Receipts and fully-read state are refreshed on return; all other account data is conservatively dirty.
        this.disposables.trackListener(room, RoomEvent.AccountData, (event) => {
            if ((event as MatrixEvent).getType() !== EventType.FullyRead) invalidate();
        });
        this.disposables.trackListener(client, ClientEvent.AccountData, invalidate);
        this.disposables.trackListener(client, ClientEvent.Sync, (state) => {
            if (state !== SyncState.Syncing) invalidate();
        });
        this.disposables.trackListener(client, MatrixEventEvent.Decrypted, invalidate);
        this.disposables.trackListener(client, RoomStateEvent.Update, invalidate);
        this.disposables.trackListener(room.currentState, RoomStateEvent.Events, invalidate);
        this.disposables.trackListener(room, RoomEvent.Timeline, invalidate);
        this.disposables.trackListener(room, RoomEvent.TimelineReset, invalidate);
        this.disposables.trackListener(room, RoomEvent.LocalEchoUpdated, invalidate);
        this.disposables.trackListener(room, RoomEvent.Redaction, invalidate);
        this.disposables.trackListener(room, RoomEvent.RedactionCancelled, invalidate);
        this.disposables.trackListener(room, RoomEvent.MyMembership, invalidate);
        for (const event of events) {
            this.disposables.trackListener(event, MatrixEventEvent.Replaced, invalidate);
            this.disposables.trackListener(event, MatrixEventEvent.Decrypted, invalidate);
            this.disposables.trackListener(event, MatrixEventEvent.BeforeRedaction, invalidate);
            this.disposables.trackListener(event, MatrixEventEvent.RelationsCreated, invalidate);
        }
    }

    /** Revalidate synchronously before starting a new visit. A failed check permanently consumes the evidence. */
    public isCompatible = (): boolean => {
        if (
            this.signature === null ||
            Date.now() - this.capturedAt >= RoomTimelineRetention.maxAgeMs ||
            this.live !== this.room.getLiveTimeline() ||
            this.state !== this.room.currentState ||
            this.crypto !== this.client.getCrypto() ||
            this.signature !== this.readSignature()
        ) {
            this.dispose();
            return false;
        }
        return true;
    };

    /** Release the invalidation listeners, including after a hit or eviction. */
    public dispose = (): void => {
        this.signature = null;
        this.disposables.dispose();
    };

    private readSignature(): string | null {
        if (
            this.client.getRoom(this.room.roomId) !== this.room ||
            this.client.getSyncState() !== SyncState.Syncing ||
            this.room.getMyMembership() !== KnownMembership.Join ||
            this.room.getPendingEvents().length > 0 ||
            this.events.length === 0 ||
            this.events.length > RoomTimelineRetention.maxEvents ||
            this.room.getLiveTimeline().getEvents().length > RoomTimelineRetention.maxEvents ||
            this.room.currentState.getStateEvents(EventType.RoomEncryption, "")
        ) {
            return null;
        }
        const contents: string[] = [];
        let length = 0;
        for (const event of this.events) {
            const content = event.getContent();
            if (
                event.getWireType() !== EventType.RoomMessage ||
                event.isEncrypted() ||
                event.isRedacted() ||
                event.status !== null ||
                content.msgtype !== "m.text" ||
                typeof content.body !== "string" ||
                content.body.length > 4096 ||
                content.formatted_body !== undefined ||
                content["m.relates_to"] !== undefined ||
                event.replacingEvent() ||
                event.getThread() ||
                ModuleApi.instance.customComponents.getMessageRenderInfo(event)
            ) {
                return null;
            }
            // SDK objects mutate in place. Comparing their identity or just their IDs would accept stale edits.
            const value = JSON.stringify([event.event, content]);
            length += value.length;
            if (length > 64 * 1024) return null;
            contents.push(value);
        }
        return JSON.stringify([
            contents,
            this.room
                .getLiveTimeline()
                .getEvents()
                .map((event) => event.getId()),
            this.client.getIgnoredUsers(),
            SettingsStore.getValue("showHiddenEventsInTimeline"),
            SettingsStore.getValue("feature_desktop_shell"),
        ]);
    }
}
