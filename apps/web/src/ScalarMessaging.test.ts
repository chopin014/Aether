// @vitest-environment happy-dom
/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { startListening, stopListening } from "./ScalarMessaging";
import { IntegrationManagers } from "./integrations/IntegrationManagers";
import { SDKContextClass } from "./contexts/SDKContextClass";
import { SlidingSyncManager } from "./SlidingSyncManager";

const MANAGER_ORIGIN = "https://integrations.example.org";
const ROOM_ID = "!viewed:example.org";
const INSTALLATIONS = "io.element.integrations.installations";

describe("ScalarMessaging", () => {
    let client: MatrixClient;
    let postMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        client = stubClient();
        vi.mocked(client.getRoom).mockReturnValue(new Room(ROOM_ID, client, client.getSafeUserId()));
        vi.spyOn(IntegrationManagers, "sharedInstance").mockReturnValue({
            getPrimaryManager: () => ({ uiUrl: `${MANAGER_ORIGIN}/ui` }),
        } as unknown as IntegrationManagers);
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockReturnValue(ROOM_ID);
        postMessage = vi.fn();
        startListening();
    });

    afterEach(() => {
        stopListening();
        vi.restoreAllMocks();
    });

    /** Post a request as the integration manager would, and wait for its answer. */
    async function request(data: Record<string, unknown>): Promise<Record<string, unknown>> {
        window.dispatchEvent(
            new MessageEvent("message", {
                origin: MANAGER_ORIGIN,
                data: { room_id: ROOM_ID, ...data },
                source: { postMessage } as unknown as Window,
            }),
        );
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
        return postMessage.mock.calls[0][0].response;
    }

    it("reads an integration's state with every state key, asking sliding sync for it", async () => {
        // Under sliding sync the viewed room has only the state its subscription names, none of an integration's.
        const installation = new MatrixEvent({
            type: INSTALLATIONS,
            state_key: "abc",
            content: { foo: "bar" },
            room_id: ROOM_ID,
            sender: "@alice:example.org",
            event_id: "$installation",
        });
        const read = vi.spyOn(SlidingSyncManager.instance, "readRoomState").mockResolvedValue([installation]);

        const response = await request({ action: "read_events", type: INSTALLATIONS, state_key: true });
        expect(read).toHaveBeenCalledWith(client, ROOM_ID, { type: INSTALLATIONS, stateKey: undefined });
        expect(response).toEqual({ events: [installation.getEffectiveEvent()] });
    });

    it("reads a bot's options with its own state key", async () => {
        const options = new MatrixEvent({
            type: "m.room.bot.options",
            state_key: "_@bot:example.org",
            content: { prefix: "!" },
            room_id: ROOM_ID,
            sender: "@alice:example.org",
            event_id: "$options",
        });
        const read = vi.spyOn(SlidingSyncManager.instance, "readRoomState").mockResolvedValue([options]);

        const response = await request({ action: "bot_options", user_id: "@bot:example.org" });
        expect(read).toHaveBeenCalledWith(client, ROOM_ID, {
            type: "m.room.bot.options",
            stateKey: "_@bot:example.org",
        });
        expect(response).toEqual({ prefix: "!" });
    });

    it("reports an error, not an empty answer, when the state cannot be had", async () => {
        vi.spyOn(SlidingSyncManager.instance, "readRoomState").mockRejectedValue(new Error("timed out"));
        const response = await request({ action: "read_events", type: INSTALLATIONS, state_key: "abc" });
        expect(response).toMatchObject({ error: { message: expect.any(String) } });
        expect(response).not.toHaveProperty("events");
    });
});
