/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { it, describe, expect, vi } from "vitest";

import { CallType } from "@element-hq/web-shared-components";

import { getMockedRtcNotificationEvent, getMockedMember } from "../../call-mocks";
import { RoomTombstoneCallTileViewModel } from "./RoomTombstoneCallTileViewModel";
import SettingsStore from "../../../../../../../settings/SettingsStore";
import { SettingLevel } from "../../../../../../../settings/SettingLevel";
import { formatTime } from "../../../../../../../DateUtils";

describe("RoomTombstoneCallTileViewModel", () => {
    it("should expose the caller display name and voice intent", () => {
        const mxEvent = getMockedRtcNotificationEvent("audio", 924285348000, 924285348000);
        mxEvent.sender = getMockedMember(mxEvent.getRoomId()!, mxEvent.getSender()!, "Alice");
        const vm = new RoomTombstoneCallTileViewModel({ mxEvent });
        expect(vm.getSnapshot()).toMatchObject({ startedByDisplayName: "Alice", type: CallType.Voice });
        vm.dispose();
    });

    it("should fall back to the sender id when the member is unavailable", () => {
        const mxEvent = getMockedRtcNotificationEvent("video", 924285348000, 924285348000);
        const vm = new RoomTombstoneCallTileViewModel({ mxEvent });
        expect(vm.getSnapshot()).toMatchObject({ startedByDisplayName: mxEvent.getSender(), type: CallType.Video });
        vm.dispose();
    });

    it("should compute timestamp correctly", () => {
        const mxEvent = getMockedRtcNotificationEvent("video", 924285348000, 924285348000);
        const vm = new RoomTombstoneCallTileViewModel({ mxEvent });
        expect(vm.getSnapshot().timestamp).toStrictEqual(formatTime(new Date(924285348000)));
    });

    it("falls back to origin_server_ts when the notification has no sender_ts", () => {
        const mxEvent = getMockedRtcNotificationEvent("video", 924285348000, 924285348000);
        vi.spyOn(mxEvent, "getContent").mockReturnValue({});
        const vm = new RoomTombstoneCallTileViewModel({ mxEvent });
        expect(vm.getSnapshot().timestamp).toStrictEqual(formatTime(new Date(924285348000)));
    });

    it("should calculate time string correctly when configured to use 12 hour format", async () => {
        const mxEvent = getMockedRtcNotificationEvent("video", 924285348000, 924285348000);
        await SettingsStore.setValue("showTwelveHourTimestamps", null, SettingLevel.DEVICE, true);
        const vm = new RoomTombstoneCallTileViewModel({ mxEvent });
        const { timestamp } = vm.getSnapshot();

        expect(timestamp).toStrictEqual(formatTime(new Date(924285348000), true));
        SettingsStore.reset();
    });

    it("should change timestamp format when setting is modified", async () => {
        await SettingsStore.setValue("showTwelveHourTimestamps", null, SettingLevel.DEVICE, false);
        const mxEvent = getMockedRtcNotificationEvent("video", 924285348000, 924285348000);
        const vm = new RoomTombstoneCallTileViewModel({ mxEvent });
        expect(vm.getSnapshot().timestamp).toStrictEqual(formatTime(new Date(924285348000)));
        await SettingsStore.setValue("showTwelveHourTimestamps", null, SettingLevel.DEVICE, true);
        await vi.waitFor(() => {
            expect(vm.getSnapshot().timestamp).toStrictEqual(formatTime(new Date(924285348000), true));
        });
        SettingsStore.reset();
    });
});
