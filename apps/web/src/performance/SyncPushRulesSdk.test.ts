/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType, type IPushRules, type ISyncResponse } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
// Test the actual patched sync implementation rather than an application mock.
// oxlint-disable-next-line no-restricted-imports
import { SyncApi } from "matrix-js-sdk/src/sync";

import { createClientWithCreds } from "../utils/createMatrixClient";

const roomId = "!room:example.com";
const userId = "@user:example.com";

function setup(initialPushRulesPromise: Promise<IPushRules | undefined>, savedSync?: ISyncResponse) {
    const client = createClientWithCreds({ homeserverUrl: "http://example.com", userId, accessToken: "token" });
    vi.spyOn(client.store, "getSavedSyncToken").mockResolvedValue(savedSync ? savedSync.next_batch : null);
    vi.spyOn(client.store, "getSavedSync").mockResolvedValue(
        savedSync ? { nextBatch: savedSync.next_batch, roomsData: savedSync.rooms!, accountData: [] } : null,
    );
    vi.spyOn(client, "storeClientOptions").mockResolvedValue(undefined);
    vi.spyOn(client, "getOrCreateFilter").mockResolvedValue("filter");
    const http = Promise.withResolvers<ISyncResponse>();
    const request = vi.spyOn(client.http, "authedRequest").mockImplementation(() => http.promise);
    const fetchRules = vi.spyOn(client, "getPushRules");
    const api = new SyncApi(client, { initialPushRulesPromise }, { logger });
    return { client, api, http, request, fetchRules };
}

describe("regular sync with pending push rules", () => {
    afterEach(() => vi.restoreAllMocks());

    it("processes cached sync while pending push rules have not answered", async () => {
        const fixture = setup(new Promise(() => {}), {
            next_batch: "cached-token",
            rooms: {
                join: {
                    [roomId]: {
                        state: {
                            events: [
                                {
                                    type: EventType.RoomMember,
                                    state_key: userId,
                                    sender: userId,
                                    event_id: "$membership",
                                    origin_server_ts: 1,
                                    content: { membership: "join" },
                                },
                                {
                                    type: EventType.RoomName,
                                    state_key: "",
                                    sender: userId,
                                    event_id: "$name",
                                    origin_server_ts: 2,
                                    content: { name: "Cached" },
                                },
                            ],
                        },
                        timeline: { events: [], prev_batch: null, limited: false },
                        ephemeral: { events: [] },
                        account_data: { events: [] },
                        unread_notifications: {},
                        summary: { "m.heroes": [] },
                    },
                },
                invite: {},
                leave: {},
                knock: {},
            },
            account_data: { events: [] },
        });
        void fixture.api.sync();
        await vi.waitFor(() => expect(fixture.client.getRoom(roomId)?.name).toBe("Cached"));
        expect(fixture.fetchRules).not.toHaveBeenCalled();
        fixture.api.stop();
    });

    it("uses pending push rules once they arrive instead of fetching them again", async () => {
        const rules = Promise.withResolvers<IPushRules | undefined>();
        const fixture = setup(rules.promise);
        const running = fixture.api.sync();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fixture.request).not.toHaveBeenCalled();
        rules.resolve({ global: { override: [] } });
        await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
        expect(fixture.fetchRules).not.toHaveBeenCalled();
        expect(fixture.client.pushRules?.global.override).toEqual([]);
        fixture.api.stop();
        fixture.http.reject(new DOMException("Stopped", "AbortError"));
        await running;
    });

    it("fetches push rules itself when the prefetch failed", async () => {
        const fixture = setup(Promise.resolve(undefined));
        fixture.fetchRules.mockResolvedValue({ global: {} });
        const running = fixture.api.sync();
        await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
        expect(fixture.fetchRules).toHaveBeenCalledOnce();
        fixture.api.stop();
        fixture.http.reject(new DOMException("Stopped", "AbortError"));
        await running;
    });
});
