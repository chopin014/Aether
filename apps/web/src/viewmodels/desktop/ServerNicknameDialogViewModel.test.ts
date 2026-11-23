/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { ServerNicknameDialogViewModel } from "./ServerNicknameDialogViewModel";
import { currentNickname, moderatorNickname, setNickname } from "../../utils/serverNickname";

vi.mock("../../utils/serverNickname", () => ({
    currentNickname: vi.fn(() => ""),
    moderatorNickname: vi.fn(() => undefined),
    setNickname: vi.fn(async () => {}),
}));

const ME = "@me:example.org";
const BOB = "@bob:example.org";

describe("ServerNicknameDialogViewModel", () => {
    let client: MatrixClient;
    let server: Room;
    let onFinished: Mock<() => void>;

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        vi.mocked(client.getUser).mockImplementation(
            (userId) => ({ displayName: userId === BOB ? "hLiTz" : "Me" }) as never,
        );
        server = new Room("!server:example.org", client, ME);
        onFinished = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const create = (userId: string): ServerNicknameDialogViewModel =>
        new ServerNicknameDialogViewModel({ client, server, userId, onFinished });

    it("starts from a moderator's view of someone else's current nickname", () => {
        vi.mocked(currentNickname).mockReturnValue("sdds do litz");
        const vm = create(BOB);
        expect(vm.getSnapshot()).toEqual({
            forSelf: false,
            personName: "hLiTz",
            nickname: "sdds do litz",
            canReset: true,
            setByModerator: false,
            busy: false,
        });
    });

    it("tells the user when a moderator's nickname applies to them", () => {
        vi.mocked(currentNickname).mockReturnValue("renamed");
        vi.mocked(moderatorNickname).mockReturnValue("renamed");
        expect(create(ME).getSnapshot()).toMatchObject({ forSelf: true, setByModerator: true, personName: "Me" });
    });

    it("saves what was typed and closes", async () => {
        const vm = create(BOB);
        vm.setNickname("litz");
        vm.save();
        expect(vm.getSnapshot().busy).toBe(true);
        await vi.waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
        expect(setNickname).toHaveBeenCalledWith(client, server, BOB, "litz");
    });

    it("resets with an empty nickname", async () => {
        const vm = create(BOB);
        vm.reset();
        await vi.waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
        expect(setNickname).toHaveBeenCalledWith(client, server, BOB, "");
    });

    it("stays open and says why when the change is refused", async () => {
        vi.mocked(setNickname).mockRejectedValueOnce(new Error("M_FORBIDDEN"));
        const vm = create(BOB);
        vm.save();
        await vi.waitFor(() => expect(vm.getSnapshot()).toMatchObject({ busy: false, error: "M_FORBIDDEN" }));
        expect(onFinished).not.toHaveBeenCalled();
        vm.setNickname("x");
        expect(vm.getSnapshot().error).toBeUndefined();
    });

    it("closes on cancel without changing anything", () => {
        create(BOB).cancel();
        expect(onFinished).toHaveBeenCalledOnce();
        expect(setNickname).not.toHaveBeenCalled();
    });
});
