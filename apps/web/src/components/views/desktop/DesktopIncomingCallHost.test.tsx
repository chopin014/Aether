/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "test-utils-rtl";
import { EventType, Room, TypedEventEmitter, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc";
import { mkEvent, stubClient } from "test-utils";

import { DesktopIncomingCallHost } from "./DesktopIncomingCallHost";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { IncomingCallStore } from "../../../stores/IncomingCallStore";
import DMRoomMap from "../../../utils/DMRoomMap";

const setRinging = vi.hoisted(() => vi.fn());
vi.mock("../../../audio/DesktopCallRingtone", () => ({
    DesktopCallRingtone: class {
        public setRinging = setRinging;
    },
}));

describe("DesktopIncomingCallHost", () => {
    let client: MatrixClient;
    let room: Room;

    beforeEach(() => {
        client = stubClient();
        room = new Room("!dm:example.org", client, client.getSafeUserId());
        const session = new TypedEventEmitter() as unknown as MatrixRTCSession;
        session.memberships = [];
        vi.mocked(client.matrixRTC.getRoomSession).mockReturnValue(session);
        vi.spyOn(DMRoomMap, "shared").mockReturnValue({
            getUserIdForRoomId: () => "@pon:example.org",
        } as unknown as DMRoomMap);
    });

    afterEach(() => {
        IncomingCallStore.instance.reset();
        vi.restoreAllMocks();
    });

    it("shows a ringing call above the app and rings until it is answered", () => {
        const { container } = render(
            <MatrixClientContext.Provider value={client}>
                <DesktopIncomingCallHost />
            </MatrixClientContext.Provider>,
        );
        expect(screen.queryByTestId("incoming-call")).toBeNull();

        act(() =>
            IncomingCallStore.instance.add(
                "dm",
                room,
                mkEvent({
                    event: true,
                    type: EventType.RTCNotification,
                    user: "@pon:example.org",
                    room: room.roomId,
                    ts: Date.now(),
                    content: { notification_type: "ring", lifetime: 30000, sender_ts: Date.now() },
                }),
            ),
        );
        const popup = screen.getByRole("region", { name: "Incoming call from @pon:example.org" });
        // Attached to the page rather than inside the app, so it stays above dialogs.
        expect(container).not.toContainElement(popup);
        expect(setRinging).toHaveBeenLastCalledWith(true);

        act(() => screen.getByRole("button", { name: "Decline" }).click());
        expect(screen.queryByTestId("incoming-call")).toBeNull();
        expect(setRinging).toHaveBeenLastCalledWith(false);
    });
});
