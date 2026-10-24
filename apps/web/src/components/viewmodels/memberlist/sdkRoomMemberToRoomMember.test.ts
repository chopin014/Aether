/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixEvent, RoomMember, User } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { sdkRoomMemberToRoomMember } from "./MemberListViewModel";
import { AetherPresenceService } from "../../../presence/AetherPresenceService";
import SettingsStore from "../../../settings/SettingsStore";
import SdkConfig from "../../../SdkConfig";
import { MatrixClientPeg } from "../../../MatrixClientPeg";

const BOB = "@bob:example.org";

describe("sdkRoomMemberToRoomMember presence", () => {
    let flag: boolean;
    let member: RoomMember;

    beforeEach(() => {
        flag = true;
        const client = stubClient();
        SdkConfig.add({ enable_presence_by_hs_url: { [client.baseUrl]: false } });
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "feature_desktop_shell" ? flag : undefined) as never);
        vi.spyOn(AetherPresenceService.instance, "store", "get").mockReturnValue({
            getSignal: () => ({ presence: "unavailable", lastSeen: Date.now(), expired: false }),
        } as never);
        member = new RoomMember("!r:example.org", BOB);
        member.user = new User(BOB);
        member.user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
    });
    afterEach(() => {
        SdkConfig.reset();
        vi.restoreAllMocks();
    });

    it("uses the Aether signal over whatever the server sent where server presence is disabled", () => {
        const result = sdkRoomMemberToRoomMember(member).member!;
        expect(result).toMatchObject({ presenceState: "unavailable", presenceSource: "aether" });
    });

    it("keeps the server's presence where it is enabled", () => {
        SdkConfig.reset();
        const result = sdkRoomMemberToRoomMember(member).member!;
        expect(result.presenceState).toBe("online");
        expect(result.presenceSource).toBeUndefined();
    });

    it("ignores Aether signals with the desktop shell off", () => {
        flag = false;
        const result = sdkRoomMemberToRoomMember(member).member!;
        expect(result.presenceSource).toBeUndefined();
    });
});
