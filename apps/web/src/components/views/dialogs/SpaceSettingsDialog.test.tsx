// @vitest-environment happy-dom
/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "test-utils-rtl";
import { type MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import SpaceSettingsDialog from "./SpaceSettingsDialog";
import DMRoomMap from "../../../utils/DMRoomMap";
import { SlidingSyncManager } from "../../../SlidingSyncManager";

describe("<SpaceSettingsDialog />", () => {
    let client: MatrixClient;
    let space: Room;

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(DMRoomMap, "shared").mockReturnValue({ getUserIdForRoomId: vi.fn() } as unknown as DMRoomMap);
        space = new Room("!server:example.org", client, client.getSafeUserId());
        space.name = "Garden";
    });

    it("keeps the Space subscribed while its settings are open", async () => {
        // Under sliding sync, a Space nobody has looked at has only what the server rail shows.
        const holds: string[] = [];
        vi.spyOn(SlidingSyncManager.instance, "holdRoom").mockImplementation((roomId) => {
            holds.push(roomId);
            return () => holds.splice(holds.indexOf(roomId), 1);
        });
        const { unmount } = render(<SpaceSettingsDialog matrixClient={client} space={space} onFinished={vi.fn()} />);
        await screen.findByText("Settings - Garden");
        expect(holds).toEqual(["!server:example.org"]);

        unmount();
        expect(holds).toEqual([]);
    });
});
