/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import {
    ClientEvent,
    EventType,
    MatrixEvent,
    MatrixEventEvent,
    PendingEventOrdering,
    Room,
    RoomEvent,
    RoomStateEvent,
    SyncState,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestClient, mkMessage } from "test-utils";

import SettingsStore from "../../../settings/SettingsStore";
import { RoomTimelineRetention } from "./RoomTimelineRetention";

vi.mock("../../../settings/SettingsStore");

describe("RoomTimelineRetention", () => {
    let client: MatrixClient;
    let room: Room;
    let event: MatrixEvent;
    let evidence: RoomTimelineRetention;

    beforeEach(() => {
        client = createTestClient();
        room = new Room("!room:test", client, "@me:test", { pendingEventOrdering: PendingEventOrdering.Detached });
        room.updateMyMembership(KnownMembership.Join);
        vi.spyOn(client, "getRoom").mockReturnValue(room);
        vi.spyOn(client, "getSyncState").mockReturnValue(SyncState.Syncing);
        event = mkMessage({ room: room.roomId, user: "@other:test", id: "$a", msg: "hello", event: true });
        room.getUnfilteredTimelineSet().addLiveEvent(event, { addToState: false });
        evidence = new RoomTimelineRetention(client, room, [event]);
    });

    afterEach(() => {
        evidence.dispose();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it("accepts an unchanged model and removes all listeners when consumed", () => {
        expect(evidence.isCompatible()).toBe(true);
        const replacements = event.listenerCount(MatrixEventEvent.Replaced);
        evidence.dispose();
        expect(event.listenerCount(MatrixEventEvent.Replaced)).toBe(replacements - 1);
        expect(evidence.isCompatible()).toBe(false);
    });

    it.each([
        "edit",
        "redaction",
        "decryption",
        "relation",
        "state",
        "access",
        "policy",
        "sync gap",
        "timeline reset",
        "client room replacement",
        "content mutation",
        "ignore change",
        "setting change",
        "age",
    ])("permanently rejects %s while parked", (change) => {
        if (change === "edit") event.emit(MatrixEventEvent.Replaced, event);
        if (change === "redaction") room.emit(RoomEvent.Redaction, event, room);
        if (change === "decryption") client.emit(MatrixEventEvent.Decrypted, event);
        if (change === "relation") event.emit(MatrixEventEvent.RelationsCreated, "m.annotation", "m.reaction");
        if (change === "state") room.currentState.emit(RoomStateEvent.Events, event, room.currentState, null);
        if (change === "access") room.updateMyMembership(KnownMembership.Leave);
        if (change === "policy") client.emit(ClientEvent.AccountData, event);
        if (change === "sync gap") {
            client.emit(ClientEvent.Sync, SyncState.Error, SyncState.Syncing);
            client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Error);
        }
        if (change === "timeline reset") room.resetLiveTimeline("new", null);
        if (change === "client room replacement") vi.spyOn(client, "getRoom").mockReturnValue(null);
        if (change === "content mutation") event.getContent().body = "changed without a notification";
        if (change === "ignore change") vi.spyOn(client, "getIgnoredUsers").mockReturnValue(["@other:test"]);
        if (change === "setting change") vi.mocked(SettingsStore.getValue).mockReturnValue(true);
        if (change === "age") vi.spyOn(Date, "now").mockReturnValue(Date.now() + RoomTimelineRetention.maxAgeMs);
        expect(evidence.isCompatible()).toBe(false);
        expect(evidence.isCompatible()).toBe(false);
    });

    it("permits read-state changes for the next visit to refresh", () => {
        room.addAccountData([new MatrixEvent({ type: EventType.FullyRead, content: { event_id: "$a" } })]);
        expect(evidence.isCompatible()).toBe(true);
    });

    it.each(["encrypted", "media", "reply", "formatted", "long", "many", "empty"])(
        "declines unsupported or oversized %s content",
        (kind) => {
            evidence.dispose();
            if (kind === "encrypted") vi.spyOn(event, "isEncrypted").mockReturnValue(true);
            if (kind === "media") event.getContent().msgtype = "m.image";
            if (kind === "reply") event.getContent()["m.relates_to"] = { "m.in_reply_to": { event_id: "$root" } };
            if (kind === "formatted") event.getContent().formatted_body = "<b>hello</b>";
            if (kind === "long") event.getContent().body = "x".repeat(4097);
            const events = kind === "many" ? Array.from({ length: 81 }, () => event) : kind === "empty" ? [] : [event];
            evidence = new RoomTimelineRetention(client, room, events);
            expect(evidence.isCompatible()).toBe(false);
        },
    );
});
