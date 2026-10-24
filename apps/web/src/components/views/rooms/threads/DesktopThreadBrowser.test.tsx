/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { EventTimelineSet, PendingEventOrdering, RoomEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopThreadBrowser } from "./DesktopThreadBrowser";
import MatrixClientContext from "../../../../contexts/MatrixClientContext";

/** Tests the actual portal and keyboard lifecycle with an isolated Matrix room. */
describe("DesktopThreadBrowser", () => {
    let client: MatrixClient;
    let room: Room;
    beforeEach(() => {
        client = stubClient();
        room = new Room("!browser:example.org", client, client.getSafeUserId(), {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        const sets: [EventTimelineSet, EventTimelineSet] = [new EventTimelineSet(room), new EventTimelineSet(room)];
        Object.defineProperty(room, "threadsTimelineSets", { value: sets });
        vi.spyOn(room, "createThreadsTimelineSets").mockResolvedValue(sets);
        vi.spyOn(room, "fetchRoomThreads").mockResolvedValue();
        vi.spyOn(room, "getMyMembership").mockReturnValue("join");
        vi.spyOn(room.currentState, "maySendEvent").mockReturnValue(true);
    });
    function Fixture({ currentRoom = room }: { currentRoom?: Room }) {
        return (
            <MatrixClientContext.Provider value={client}>
                <div className="mx_RoomHeader">
                    <DesktopThreadBrowser key={currentRoom.roomId} room={currentRoom} />
                </div>
                <section aria-label="Channel">
                    <button>Channel action</button>
                </section>
                <section aria-label="Members">Room members remain visible</section>
            </MatrixClientContext.Provider>
        );
    }
    it("opens a non-modal portal, focuses search, and returns focus on Escape", async () => {
        render(<Fixture />);
        const trigger = screen.getByRole("button", { name: "Threads" });
        await userEvent.click(trigger);
        expect(screen.getByRole("dialog", { name: "Threads" })).toHaveAttribute("aria-modal", "false");
        await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search threads" })).toHaveFocus());
        expect(screen.getByRole("region", { name: "Channel" })).toBeVisible();
        expect(screen.getByRole("region", { name: "Members" })).toBeVisible();
        const globalShortcut = vi.fn((event: KeyboardEvent) => event.preventDefault());
        document.addEventListener("keydown", globalShortcut);
        await userEvent.keyboard("{Escape}");
        document.removeEventListener("keydown", globalShortcut);
        expect(globalShortcut).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        expect(client.sendMessage).not.toHaveBeenCalled();
    });
    it("cancels creation without sending, preserves its draft, and dismisses on an outside click", async () => {
        render(<Fixture />);
        const trigger = screen.getByRole("button", { name: "Threads" });
        await userEvent.click(trigger);
        await userEvent.click(await screen.findByRole("button", { name: "Create thread" }));
        await userEvent.type(screen.getByLabelText("Starter message"), "New topic");
        await userEvent.type(screen.getByLabelText("First reply"), "First message");
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("searchbox")).toHaveFocus();
        await userEvent.click(screen.getByRole("button", { name: "Create thread" }));
        expect(screen.getByLabelText("Starter message")).toHaveValue("New topic");
        expect(screen.getByLabelText("First reply")).toHaveValue("First message");
        await userEvent.click(screen.getByRole("button", { name: "Channel action" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(client.sendMessage).not.toHaveBeenCalled();
    });
    it("closes and disposes discovery when the parent room changes", async () => {
        const { rerender } = render(<Fixture />);
        await userEvent.click(screen.getByRole("button", { name: "Threads" }));
        await screen.findByRole("heading", { name: "There are no threads." });
        const otherRoom = new Room("!other:example.org", client, client.getSafeUserId());
        rerender(<Fixture currentRoom={otherRoom} />);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(room.listenerCount(RoomEvent.Timeline)).toBe(1);
    });
});
