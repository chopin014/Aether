/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import {
    EventType,
    Room,
    RuleId,
    TweakName,
    type IContent,
    type IPushRule,
    type MatrixClient,
    type MatrixEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";
import { type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc";

import { mkEvent, mkRoomMember, stubClient } from "test-utils";
import { IncomingCallViewModel } from "./IncomingCallViewModel";
import { IncomingCallStore } from "../../stores/IncomingCallStore";
import { type DesktopCallRingtone } from "../../audio/DesktopCallRingtone";
import { type MatrixDispatcher } from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import DMRoomMap from "../../utils/DMRoomMap";
import * as notifications from "../../utils/notifications";

describe("IncomingCallViewModel", () => {
    let client: Mocked<MatrixClient>;
    let room: Room;
    let store: IncomingCallStore;
    let ringtone: { setRinging: ReturnType<typeof vi.fn> };
    let dispatcher: { dispatch: ReturnType<typeof vi.fn> };
    let directUserId: string | undefined;
    let vm: IncomingCallViewModel;

    const notification = (content: IContent = {}): MatrixEvent =>
        mkEvent({
            event: true,
            type: EventType.RTCNotification,
            user: "@pon:example.org",
            room: room.roomId,
            id: "$ring",
            ts: Date.now(),
            content: {
                "notification_type": "ring",
                "m.call.intent": "audio",
                "m.relates_to": { rel_type: "m.reference", event_id: "$member" },
                "lifetime": 30000,
                "sender_ts": Date.now(),
                ...content,
            },
        });

    const create = (): IncomingCallViewModel =>
        (vm = new IncomingCallViewModel({
            client,
            store,
            ringtone: ringtone as unknown as DesktopCallRingtone,
            dispatcher: dispatcher as unknown as MatrixDispatcher,
        }));

    beforeEach(() => {
        client = vi.mocked(stubClient());
        room = new Room("!dm:example.org", client, client.getSafeUserId());
        room.name = "Business Meeting";
        const pon = mkRoomMember(room.roomId, "@pon:example.org");
        pon.name = "Pon";
        vi.spyOn(room, "getMember").mockImplementation((id) => (id === pon.userId ? pon : null));
        const session = new TypedEventEmitter() as unknown as MatrixRTCSession;
        session.memberships = [{ userId: "@pon:example.org" } as CallMembership];
        vi.mocked(client.matrixRTC.getRoomSession).mockReturnValue(session);
        directUserId = "@pon:example.org";
        vi.spyOn(DMRoomMap, "shared").mockReturnValue({
            getUserIdForRoomId: () => directUserId,
        } as unknown as DMRoomMap);
        store = new IncomingCallStore();
        ringtone = { setRinging: vi.fn() };
        dispatcher = { dispatch: vi.fn() };
    });

    afterEach(() => {
        vm?.dispose();
        store.reset();
        vi.restoreAllMocks();
    });

    it("shows the caller of a direct call", () => {
        store.add("dm", room, notification());
        expect(create().getSnapshot().calls).toEqual([
            { id: "dm", name: "Pon", avatarUrl: undefined, initialLetter: "P", kind: "voice", startedBy: undefined },
        ]);
    });

    it("shows the room and who started a call in a group room", () => {
        directUserId = undefined;
        create();
        store.add("group", room, notification({ "notification_type": "notification", "m.call.intent": "video" }));
        expect(vm.getSnapshot().calls).toEqual([
            expect.objectContaining({ name: "Business Meeting", kind: "video", startedBy: "Pon" }),
        ]);
    });

    it("rings only after the view mounts, and only for a direct call", () => {
        create();
        store.add("dm", room, notification());
        expect(ringtone.setRinging).not.toHaveBeenCalled();

        const stop = vm.startRingtone();
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(true);
        store.dismiss("dm");
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(false);
        store.add("group", room, notification({ notification_type: "notification" }));
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(false);
        store.add("dm", room, notification());
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(true);

        stop();
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(false);
    });

    it.each<[string, Partial<IPushRule> | undefined, boolean]>([
        [
            "the incoming call sound is on",
            { enabled: true, actions: [{ set_tweak: TweakName.Sound, value: "ring" }] },
            true,
        ],
        ["the server has no incoming call rule", undefined, true],
        ["the incoming call sound is off", { enabled: true, actions: [] }, false],
        [
            "the incoming call rule is disabled",
            { enabled: false, actions: [{ set_tweak: TweakName.Sound, value: "ring" }] },
            false,
        ],
    ])("rings out loud only when %s", (_, rule, audible) => {
        vi.mocked(client.pushProcessor.getPushRuleById).mockImplementation((id) =>
            id === RuleId.IncomingCall && rule ? ({ rule_id: id, default: true, ...rule } as IPushRule) : null,
        );
        store.add("dm", room, notification());
        create().startRingtone();
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(audible);
    });

    it("stays silent while notifications are silenced on this device", () => {
        vi.spyOn(notifications, "localNotificationsAreSilenced").mockReturnValue(true);
        store.add("dm", room, notification());
        create().startRingtone();
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(false);
    });

    it("joins the call straight away when accepted", () => {
        store.add("dm", room, notification({ "m.call.intent": "video" }));
        create().accept("dm", true);
        expect(store.calls).toHaveLength(0);
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.ViewRoom,
                room_id: room.roomId,
                view_call: true,
                skipLobby: true,
                voiceOnly: false,
            }),
        );
    });

    it("joins a voice call without the camera even if asked for video", () => {
        store.add("dm", room, notification());
        create().accept("dm", true);
        expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ voiceOnly: true }));
    });

    it("ignores answers to a call that has stopped ringing", () => {
        create().accept("gone", false);
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("declines through the store", () => {
        store.add("dm", room, notification());
        create().decline("dm");
        expect(vm.getSnapshot().calls).toEqual([]);
        expect(client.sendRtcDecline).toHaveBeenCalledWith(room.roomId, "$ring");
    });

    it("stops ringing and listening when disposed", () => {
        store.add("dm", room, notification());
        create().startRingtone();
        vm.dispose();
        expect(ringtone.setRinging).toHaveBeenLastCalledWith(false);
        store.dismiss("dm");
        expect(vm.getSnapshot().calls).toHaveLength(1);
    });
});
