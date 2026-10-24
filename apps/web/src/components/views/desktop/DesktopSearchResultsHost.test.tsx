/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { MatrixEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopSearchResultsHost } from "./DesktopSearchResultsHost";
import { DesktopMessageSearchStore } from "../../../stores/DesktopMessageSearchStore";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { parseQuery } from "../../../utils/desktopSearch/query";
import eventSearch from "../../../Searching";

vi.mock("../../../Searching", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../Searching")>()),
    default: vi.fn(),
    searchPagination: vi.fn(),
}));

describe("DesktopSearchResultsHost", () => {
    let client: MatrixClient;
    const store = DesktopMessageSearchStore.instance;

    beforeEach(() => {
        client = stubClient();
        const room = new Room("!gen:x", client, "@me:x");
        vi.spyOn(client, "getRoom").mockReturnValue(room);
        vi.spyOn(client, "isRoomEncrypted").mockReturnValue(false);
        const event = new MatrixEvent({
            event_id: "$1",
            room_id: "!gen:x",
            sender: "@alice:x",
            type: "m.room.message",
            origin_server_ts: 1000,
            content: { msgtype: "m.text", body: "the budget is ready" },
        });
        vi.mocked(eventSearch).mockResolvedValue({
            results: [{ context: { getEvent: () => event } }],
            highlights: ["budget"],
            count: 1,
        } as Awaited<ReturnType<typeof eventSearch>>);
    });
    afterEach(() => {
        store.close();
        vi.clearAllMocks();
    });

    const renderHost = () =>
        render(
            <MatrixClientContext.Provider value={client}>
                <DesktopSearchResultsHost />
            </MatrixClientContext.Provider>,
        );

    it("renders nothing until a search starts", () => {
        const { container } = renderHost();
        expect(container).toBeEmptyDOMElement();
    });

    it("shows the results of a search in the right column and closes with the button", async () => {
        renderHost();
        act(() => store.start(parseQuery("budget"), { kind: "room", roomIds: ["!gen:x"] }));

        expect(await screen.findByRole("heading", { name: "1 result" })).toBeVisible();
        expect(screen.getByRole("region", { name: "!gen:x" })).toBeVisible();
        expect(screen.getByText("budget").tagName).toBe("MARK");

        await userEvent.click(screen.getByRole("button", { name: "Close search results" }));
        await waitFor(() => expect(store.active).toBeNull());
        expect(screen.queryByRole("region", { name: "Search results" })).not.toBeInTheDocument();
    });
});
