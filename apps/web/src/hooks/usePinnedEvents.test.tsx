/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React, { type PropsWithChildren } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "test-utils-rtl";
import { EventType, type MatrixClient, MatrixEvent, RelationType, Room } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { fetchPinnedEvent, useFetchedPinnedEvents } from "./usePinnedEvents";
import MatrixClientContext from "../contexts/MatrixClientContext";

describe("useFetchedPinnedEvents", () => {
    const roomId = "!room:server";
    const userId = "@alice:server";
    const pinnedEventId = "$pinned:server";

    let client: MatrixClient;
    let room: Room;
    // Stable identity: the hook memoises on this array, so a fresh literal per render would
    // refetch forever.
    const pinnedIds = [pinnedEventId];

    const makeEvent = (id: string, content: object): MatrixEvent =>
        new MatrixEvent({
            type: EventType.RoomMessage,
            sender: userId,
            room_id: roomId,
            event_id: id,
            origin_server_ts: 0,
            content,
        });

    const edit = (targetId: string, id: string): MatrixEvent =>
        makeEvent(id, {
            "msgtype": "m.text",
            "body": "* edited",
            "m.new_content": { msgtype: "m.text", body: "edited" },
            "m.relates_to": { rel_type: RelationType.Replace, event_id: targetId },
        });

    const wrapper = ({ children }: PropsWithChildren): React.JSX.Element => (
        <MatrixClientContext.Provider value={client}>{children}</MatrixClientContext.Provider>
    );

    beforeEach(() => {
        client = stubClient();
        room = new Room(roomId, client, userId);
        // The pinned event is deliberately not in the local timeline, so the hook holds a copy of
        // its own that nothing else keeps up to date.
        vi.spyOn(client, "fetchRoomEvent").mockResolvedValue(
            makeEvent(pinnedEventId, { msgtype: "m.text", body: "original" }).event as never,
        );
        vi.spyOn(client, "relations").mockResolvedValue({ events: [] });
    });

    it("gives the edited content for a pinned event that is edited", async () => {
        const { result } = renderHook(() => useFetchedPinnedEvents(room, pinnedIds), { wrapper });
        await waitFor(() => expect(result.current).toHaveLength(1));
        expect(result.current[0].getContent().body).toBe("original");

        await act(async () => {
            await room.addLiveEvents([edit(pinnedEventId, "$edit:server")], { addToState: false });
        });

        await waitFor(() => expect(result.current[0].getContent().body).toBe("edited"));
    });

    it("leaves a pinned event alone when a different event is edited", async () => {
        const { result } = renderHook(() => useFetchedPinnedEvents(room, pinnedIds), { wrapper });
        await waitFor(() => expect(result.current).toHaveLength(1));

        await act(async () => {
            await room.addLiveEvents([edit("$somethingElse:server", "$edit2:server")], { addToState: false });
        });

        // Wait long enough that an edit would have been applied, then confirm none was.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(result.current[0].getContent().body).toBe("original");
    });
    it("retains an undecryptable event for Element's decryption failure renderer", async () => {
        const encrypted = new MatrixEvent({
            event_id: pinnedEventId,
            room_id: roomId,
            sender: userId,
            type: EventType.RoomMessageEncrypted,
            content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "unavailable keys" },
        });
        vi.spyOn(client, "fetchRoomEvent").mockResolvedValue(encrypted.event as never);
        vi.spyOn(client, "decryptEventIfNeeded").mockResolvedValue(undefined);
        const result = await fetchPinnedEvent(room, pinnedEventId, client);
        expect(result?.isEncrypted()).toBe(true);
        expect(result?.getSender()).toBe(userId);
        expect(client.decryptEventIfNeeded).toHaveBeenCalled();
    });

    it("returns unavailable for a malformed event without a sender", async () => {
        const malformed = makeEvent(pinnedEventId, { body: "Missing sender", msgtype: "m.text" });
        delete malformed.event.sender;
        vi.spyOn(client, "fetchRoomEvent").mockResolvedValue(malformed.event as never);
        expect(await fetchPinnedEvent(room, pinnedEventId, client)).toBeNull();
    });

    it("retains removed messages for Element's redacted body renderer", async () => {
        const removed = makeEvent(pinnedEventId, {});
        removed.makeRedacted(
            new MatrixEvent({
                event_id: "$redaction",
                type: EventType.RoomRedaction,
                room_id: roomId,
                sender: userId,
                redacts: pinnedEventId,
                content: {},
            }),
            room,
        );
        vi.spyOn(client, "fetchRoomEvent").mockResolvedValue(removed.event as never);
        expect((await fetchPinnedEvent(room, pinnedEventId, client))?.isRedacted()).toBe(true);
    });
    it("does not apply a fetched edit from another sender", async () => {
        const forged = edit(pinnedEventId, "$forged");
        forged.event.sender = "@mallory:server";
        vi.spyOn(client, "relations").mockResolvedValue({ events: [forged] });
        expect((await fetchPinnedEvent(room, pinnedEventId, client))?.getContent().body).toBe("original");
    });
});
