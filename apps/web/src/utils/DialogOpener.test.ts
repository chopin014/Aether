// @vitest-environment happy-dom
/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DialogOpener } from "./DialogOpener";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import Modal, { type IHandle } from "../Modal";
import RoomSettingsDialog from "../components/views/dialogs/RoomSettingsDialog";
import SpaceSettingsDialog from "../components/views/dialogs/SpaceSettingsDialog";
import { SlidingSyncManager } from "../SlidingSyncManager";
import { SDKContextClass } from "../contexts/SDKContextClass";

describe("DialogOpener", () => {
    let client: MatrixClient;
    let closeDialog: () => void;
    let release: Mock<() => void>;

    beforeEach(() => {
        client = stubClient();
        DialogOpener.instance.prepare(client);
        const { promise, resolve } = Promise.withResolvers<unknown[]>();
        closeDialog = () => resolve([]);
        vi.spyOn(Modal, "createDialog").mockReturnValue({
            finished: promise,
            close: vi.fn(),
        } as unknown as IHandle<typeof RoomSettingsDialog>);
        release = vi.fn<() => void>();
        vi.spyOn(SlidingSyncManager.instance, "holdRoom").mockReturnValue(release);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps a room subscribed while its settings are open", async () => {
        defaultDispatcher.dispatch({ action: "open_room_settings", room_id: "!listed:example.org" }, true);
        expect(Modal.createDialog).toHaveBeenCalledWith(
            RoomSettingsDialog,
            expect.objectContaining({ roomId: "!listed:example.org" }),
            undefined,
            false,
            true,
        );
        expect(SlidingSyncManager.instance.holdRoom).toHaveBeenCalledWith("!listed:example.org");
        await Promise.resolve();
        expect(release).not.toHaveBeenCalled();

        closeDialog();
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });

    it("holds the room being viewed when no room is given", () => {
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockReturnValue("!viewed:example.org");
        defaultDispatcher.dispatch({ action: "open_room_settings" }, true);
        expect(SlidingSyncManager.instance.holdRoom).toHaveBeenCalledWith("!viewed:example.org");
    });

    it("keeps a Space subscribed while its settings are open", async () => {
        const space = new Room("!server:example.org", client, client.getSafeUserId());
        defaultDispatcher.dispatch({ action: Action.OpenSpaceSettings, space }, true);
        expect(Modal.createDialog).toHaveBeenCalledWith(
            SpaceSettingsDialog,
            expect.objectContaining({ space }),
            undefined,
            false,
            true,
        );
        expect(SlidingSyncManager.instance.holdRoom).toHaveBeenCalledWith("!server:example.org");

        closeDialog();
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });
});
