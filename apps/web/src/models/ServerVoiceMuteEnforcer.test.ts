/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room, RoomStateEvent, RoomType, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { stubClient } from "test-utils";

import { ServerVoiceMuteEnforcer } from "./ServerVoiceMuteEnforcer";
import { CallEvent, ConnectionState, ElementCall, type Call } from "./Call";
import SettingsStore from "../settings/SettingsStore";
import {
    isMicrophoneChangeForced,
    SERVER_VOICE_MUTE_EVENT_TYPE,
    serverVoiceMuteStateKey,
} from "../utils/call/serverVoiceMute";

const ME = "@me:example.org";
const MOD = "@mod:example.org";
const VOICE = "!voice:example.org";

/** A call in a voice channel, as far as the enforcer looks at it. */
type FakeCall = ElementCall & {
    setDeviceMute: ReturnType<typeof vi.fn>;
    setAudioOutputEnabled: ReturnType<typeof vi.fn>;
    reportMicrophone(enabled: boolean): void;
};

function fakeCall(roomId = VOICE, connected = true): FakeCall {
    // What Element Call last reported about the microphone and camera.
    let devices = { audio_enabled: true, video_enabled: false };
    const call = Object.defineProperties(Object.create(ElementCall.prototype), {
        roomId: { value: roomId },
        _connectionState: {
            value: connected ? ConnectionState.Connected : ConnectionState.Disconnected,
            writable: true,
        },
        _deviceMuteState: { get: () => devices },
        setDeviceMute: {
            value: vi.fn(async (request: { audio_enabled?: boolean }) => {
                devices = { ...devices, ...request };
                return devices;
            }),
        },
        setAudioOutputEnabled: { value: vi.fn() },
        reportMicrophone: {
            value: (enabled: boolean): void => {
                devices = { audio_enabled: enabled, video_enabled: false };
                call.emit(CallEvent.DeviceMute, devices);
            },
        },
    }) as FakeCall;
    return call;
}

describe("ServerVoiceMuteEnforcer", () => {
    let client: MatrixClient;
    let server: Room;
    let calls: Call[];
    let enforcer: ServerVoiceMuteEnforcer;

    /** A moderator changes the user's record, as it arrives through sync. */
    const moderate = (content: object): void => {
        const event = new MatrixEvent({
            type: SERVER_VOICE_MUTE_EVENT_TYPE,
            state_key: serverVoiceMuteStateKey(ME),
            room_id: server.roomId,
            sender: MOD,
            content,
        });
        server.currentState.setStateEvents([event]);
        client.emit(RoomStateEvent.Events, event, server.currentState, null);
    };

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        server = new Room("!server:example.org", client, ME);
        const state = (type: string, content: object, stateKey = ""): MatrixEvent =>
            new MatrixEvent({ type, state_key: stateKey, room_id: server.roomId, sender: ME, content });
        server.currentState.setStateEvents([
            state(EventType.RoomCreate, { creator: ME, room_version: "10", type: RoomType.Space }),
            state(EventType.SpaceChild, { via: ["example.org"] }, VOICE),
        ]);
        server.updateMyMembership(KnownMembership.Join);
        vi.mocked(client.getRooms).mockReturnValue([server]);
        calls = [];
        enforcer = new ServerVoiceMuteEnforcer(client, () => calls);
    });

    afterEach(() => {
        enforcer.dispose();
        vi.restoreAllMocks();
    });

    it("turns the microphone off when a moderator mutes the user, and keeps it off", () => {
        const call = fakeCall();
        calls.push(call);
        enforcer.update();
        expect(call.setDeviceMute).not.toHaveBeenCalled();

        moderate({ muted: true });
        expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: false });

        // The call's own button, the dock or push to talk turns it back on: it goes off again.
        call.setDeviceMute.mockClear();
        call.reportMicrophone(true);
        expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: false });
    });

    it("marks its own microphone changes while they are under way, so they are not taken for the user's", async () => {
        const call = fakeCall();
        calls.push(call);
        enforcer.update();
        moderate({ muted: true });
        expect(isMicrophoneChangeForced(call)).toBe(true);
        await vi.waitFor(() => expect(isMicrophoneChangeForced(call)).toBe(false));

        moderate({});
        expect(call.setDeviceMute).toHaveBeenLastCalledWith({ audio_enabled: true });
        expect(isMicrophoneChangeForced(call)).toBe(true);
        await vi.waitFor(() => expect(isMicrophoneChangeForced(call)).toBe(false));
    });

    it("turns the microphone back on once the mute is lifted, as it was before", () => {
        const call = fakeCall();
        calls.push(call);
        enforcer.update();
        moderate({ muted: true });
        call.setDeviceMute.mockClear();
        moderate({});
        expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: true });
        expect(call.deviceMuteState?.audio_enabled).toBe(true);

        // Only once: later changes to the server leave the microphone to the user.
        call.setDeviceMute.mockClear();
        call.reportMicrophone(false);
        moderate({});
        expect(call.setDeviceMute).not.toHaveBeenCalled();
    });

    it("leaves the microphone off once the mute is lifted when the user had it off", () => {
        const call = fakeCall();
        calls.push(call);
        call.reportMicrophone(false);
        enforcer.update();
        moderate({ muted: true });
        expect(call.setDeviceMute).not.toHaveBeenCalled();
        moderate({});
        expect(call.setDeviceMute).not.toHaveBeenCalled();
    });

    it("leaves the microphone off once the mute is lifted when the user muted themselves meanwhile", () => {
        const call = fakeCall();
        calls.push(call);
        enforcer.update();
        moderate({ muted: true });
        call.setDeviceMute.mockClear();
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            (name) => (name === "audioInputMuted" ? true : undefined) as never,
        );
        moderate({});
        expect(call.setDeviceMute).not.toHaveBeenCalled();
    });

    it("silences the call while deafened, and plays it again afterwards unless the user deafened themselves", () => {
        const call = fakeCall();
        calls.push(call);
        enforcer.update();
        moderate({ deafened: true });
        expect(call.setAudioOutputEnabled).toHaveBeenCalledWith(false);
        expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: false });

        const getValue = vi.spyOn(SettingsStore, "getValue");
        getValue.mockImplementation((name) => (name === "desktopDeafened" ? false : undefined) as never);
        moderate({ muted: true });
        expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(true);

        moderate({ deafened: true });
        getValue.mockImplementation((name) => (name === "desktopDeafened" ? true : undefined) as never);
        moderate({});
        expect(call.setAudioOutputEnabled).toHaveBeenLastCalledWith(false);
    });

    it("applies the mute to a call joined while muted, once it connects", () => {
        moderate({ muted: true });
        const call = fakeCall(VOICE, false);
        calls.push(call);
        enforcer.update();
        expect(call.setDeviceMute).not.toHaveBeenCalled();
        (call as unknown as { _connectionState: ConnectionState })._connectionState = ConnectionState.Connected;
        call.emit(CallEvent.ConnectionState, ConnectionState.Connected, ConnectionState.Disconnected);
        expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: false });
    });

    it("leaves calls of channels outside the server alone", () => {
        const call = fakeCall("!elsewhere:example.org");
        calls.push(call);
        moderate({ deafened: true });
        enforcer.update();
        expect(call.setDeviceMute).not.toHaveBeenCalled();
        expect(call.setAudioOutputEnabled).not.toHaveBeenCalled();
    });

    it("stops watching calls the user left, and everything once disposed", () => {
        const call = fakeCall();
        calls.push(call);
        enforcer.update();
        calls.length = 0;
        enforcer.update();
        moderate({ muted: true });
        call.reportMicrophone(true);
        expect(call.setDeviceMute).not.toHaveBeenCalled();

        calls.push(call);
        enforcer.dispose();
        moderate({ deafened: true });
        expect(call.setAudioOutputEnabled).not.toHaveBeenCalled();
    });
});
