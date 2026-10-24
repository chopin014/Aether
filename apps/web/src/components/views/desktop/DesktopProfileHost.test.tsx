/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { Room, RoomMember, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopProfileHost } from "./DesktopProfileHost";
import { DesktopFullProfileDialog } from "./DesktopFullProfileDialog";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { SDKContext } from "../../../contexts/SDKContext";
import { SDKContextClass } from "../../../contexts/SDKContextClass";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import Modal, { ModalManagerEvent } from "../../../Modal";
import SettingsStore from "../../../settings/SettingsStore";
import UIStore from "../../../stores/UIStore";
import * as windowControls from "../../../utils/windowControls";

describe("DesktopProfileHost", () => {
    let client: MatrixClient;
    let room: Room;
    let member: RoomMember;

    function Fixture(): React.JSX.Element {
        return (
            <SDKContext.Provider value={SDKContextClass.instance}>
                <MatrixClientContext.Provider value={client}>
                    <button onClick={() => defaultDispatcher.dispatch({ action: Action.ViewUser, member })}>
                        Open Robin
                    </button>
                    <button onClick={() => defaultDispatcher.dispatch({ action: Action.ViewUser })}>
                        Toggle members
                    </button>
                    <button>Elsewhere</button>
                    <DesktopProfileHost />
                </MatrixClientContext.Provider>
            </SDKContext.Provider>
        );
    }

    beforeEach(() => {
        client = stubClient();
        room = new Room("!room:example.org", client, client.getSafeUserId());
        member = new RoomMember(room.roomId, "@robin:example.org");
        member.name = "Robin";
        member.membership = "join";
        vi.spyOn(room, "getMember").mockImplementation((id) => (id === member.userId ? member : null));
        vi.mocked(client.getRoom).mockImplementation((id) => (id === room.roomId ? room : null));
        vi.mocked(client.getCrypto).mockReturnValue(undefined);
        vi.mocked(client.isGuest).mockReturnValue(false);
        vi.mocked(client.isUserIgnored).mockReturnValue(false);
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        vi.spyOn(Modal, "createDialog").mockReturnValue({ close: vi.fn() } as never);
    });
    afterEach(() => vi.restoreAllMocks());

    it("opens an anchored, non-modal card from a click and returns focus to it on Escape", async () => {
        render(<Fixture />);
        const trigger = screen.getByRole("button", { name: "Open Robin" });
        await userEvent.click(trigger);
        const card = await screen.findByRole("dialog", { name: "Profile" });
        expect(card).toHaveAttribute("aria-modal", "false");
        expect(screen.getByRole("heading", { name: "Robin" })).toBeInTheDocument();
        expect(screen.getByText("@robin:example.org")).toBeInTheDocument();
        // Positioned beside the trigger rather than left hidden at the origin.
        await waitFor(() => expect(card.style.visibility).toBe("visible"));
        await waitFor(() => expect(screen.getByLabelText("Message Robin")).toHaveFocus());

        const globalShortcut = vi.fn((event: KeyboardEvent) => event.preventDefault());
        document.addEventListener("keydown", globalShortcut);
        await userEvent.keyboard("{Escape}");
        document.removeEventListener("keydown", globalShortcut);
        expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull();
        expect(trigger).toHaveFocus();
    });

    it("keeps a tall card inside a narrow viewport after moving below window controls", async () => {
        const store = UIStore.instance;
        const oldWidth = store.windowWidth;
        const oldHeight = store.windowHeight;
        store.windowWidth = 400;
        store.windowHeight = 300;
        vi.spyOn(windowControls, "readWindowControls").mockReturnValue({ inline: 138, block: 48 });
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
            top: 8,
            left: 8,
            width: 380,
            height: 280,
            right: 388,
            bottom: 288,
        } as DOMRect);
        try {
            render(<Fixture />);
            await userEvent.click(screen.getByRole("button", { name: "Open Robin" }));
            const card = await screen.findByRole("dialog", { name: "Profile" });
            await waitFor(() => expect(card.style.top).toBe("56px"));
            expect(parseFloat(card.style.top) + parseFloat(card.style.maxHeight)).toBe(292);
        } finally {
            store.windowWidth = oldWidth;
            store.windowHeight = oldHeight;
        }
    });

    it("closes when the same person is clicked again or the page is clicked outside", async () => {
        render(<Fixture />);
        const trigger = screen.getByRole("button", { name: "Open Robin" });
        await userEvent.click(trigger);
        await screen.findByRole("dialog", { name: "Profile" });
        await userEvent.click(trigger);
        expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull();

        await userEvent.click(trigger);
        await screen.findByRole("dialog", { name: "Profile" });
        fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
        expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull();
    });

    it("keeps the card open for pointer presses inside it", async () => {
        render(<Fixture />);
        await userEvent.click(screen.getByRole("button", { name: "Open Robin" }));
        const card = await screen.findByRole("dialog", { name: "Profile" });
        fireEvent.pointerDown(card);
        expect(screen.getByRole("dialog", { name: "Profile" })).toBeInTheDocument();
    });

    it("opens the full profile modal from the name, after restoring focus to the trigger", async () => {
        render(<Fixture />);
        const trigger = screen.getByRole("button", { name: "Open Robin" });
        await userEvent.click(trigger);
        await userEvent.click(await screen.findByRole("button", { name: "Robin" }));
        expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull();
        expect(trigger).toHaveFocus();
        expect(Modal.createDialog).toHaveBeenCalledWith(
            DesktopFullProfileDialog,
            expect.objectContaining({ client, member, room }),
            "mx_Dialog_desktopProfile",
        );
    });

    it("opens the full profile directly when nothing visible triggered the request", async () => {
        render(<Fixture />);
        defaultDispatcher.dispatch({ action: Action.ViewUser, member }, true);
        await waitFor(() => expect(Modal.createDialog).toHaveBeenCalled());
        expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull();
    });

    it("leaves a request without a person to the member list toggle", async () => {
        render(<Fixture />);
        await userEvent.click(screen.getByRole("button", { name: "Toggle members" }));
        expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull();
        expect(Modal.createDialog).not.toHaveBeenCalled();
    });

    it("closes when a modal opens over it", async () => {
        render(<Fixture />);
        await userEvent.click(screen.getByRole("button", { name: "Open Robin" }));
        await screen.findByRole("dialog", { name: "Profile" });
        Modal.emit(ModalManagerEvent.Opened);
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull());
    });
});
