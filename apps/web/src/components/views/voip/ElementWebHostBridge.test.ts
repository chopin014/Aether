/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import ActiveWidgetStore from "../../../stores/ActiveWidgetStore";
import { CallStore } from "../../../stores/CallStore";
import { type Call, type ElementCall } from "../../../models/Call";
import { type ElementCallHostBridge } from "@element-hq/element-call-component/api";
import { logger } from "matrix-js-sdk/src/logger";
import { ElementWebHostBridge } from "./ElementWebHostBridge";
import SettingsStore from "../../../settings/SettingsStore";
import Modal from "../../../Modal";

describe("ElementWebHostBridge", () => {
    const widgetId = "widget1";
    const roomId = "!1:example.org";
    let call: {
        roomId: string;
        markReady: ReturnType<typeof vi.fn>;
        handleJoined: ReturnType<typeof vi.fn>;
        handleHangup: ReturnType<typeof vi.fn>;
        handleClose: ReturnType<typeof vi.fn>;
        handleDeviceMute: ReturnType<typeof vi.fn>;
        handleSpeakingUsers: ReturnType<typeof vi.fn>;
        handleScreenShare: ReturnType<typeof vi.fn>;
        handleVoiceStates: ReturnType<typeof vi.fn>;
        handleConnectionStats: ReturnType<typeof vi.fn>;
    };
    let setWidgetPersistence: ReturnType<typeof vi.spyOn>;
    let bridge: ElementWebHostBridge;

    beforeEach(() => {
        call = {
            roomId,
            markReady: vi.fn(),
            handleJoined: vi.fn(),
            handleHangup: vi.fn(),
            handleClose: vi.fn(),
            handleDeviceMute: vi.fn(),
            handleSpeakingUsers: vi.fn(),
            handleScreenShare: vi.fn(),
            handleVoiceStates: vi.fn(),
            handleConnectionStats: vi.fn(),
        };
        setWidgetPersistence = vi
            .spyOn(ActiveWidgetStore.instance, "setWidgetPersistence")
            .mockImplementation(() => {});
        bridge = new ElementWebHostBridge(call as unknown as ElementCall, { widgetId, widgetRoomId: roomId });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("forwards what Element Call tells the host to the call model", async () => {
        await bridge.contentLoaded();
        expect(call.markReady).toHaveBeenCalled();
        await bridge.notifyJoined();
        expect(call.handleJoined).toHaveBeenCalled();
        await bridge.notifyHungUp();
        expect(call.handleHangup).toHaveBeenCalled();
        await bridge.notifyDeviceMute({ audio_enabled: false, video_enabled: true });
        expect(call.handleDeviceMute).toHaveBeenCalledWith({ audio_enabled: false, video_enabled: true });
        await bridge.notifySpeakingUsers(["@alice:example.org", "@bob:example.org"]);
        expect(call.handleSpeakingUsers).toHaveBeenCalledWith(["@alice:example.org", "@bob:example.org"]);
        await bridge.notifySpeakingUsers([]);
        expect(call.handleSpeakingUsers).toHaveBeenLastCalledWith([]);
        const screenShare = { available: true, sharing: false, remoteSharerIds: ["@alice:example.org"] };
        await bridge.notifyScreenShare(screenShare);
        expect(call.handleScreenShare).toHaveBeenCalledWith(screenShare);
        const voiceStates = [{ userId: "@alice:example.org", muted: true, deafened: true }];
        await bridge.notifyVoiceStates(voiceStates);
        expect(call.handleVoiceStates).toHaveBeenCalledWith(voiceStates);
        const connectionStats = {
            state: "connected" as const,
            quality: "good" as const,
            rttMs: 17,
            averageRttMs: 17,
            outboundPacketLossPercent: 0,
            history: [17],
        };
        await bridge.notifyConnectionStats(connectionStats);
        expect(call.handleConnectionStats).toHaveBeenCalledWith(connectionStats);
        await bridge.close();
        expect(call.handleClose).toHaveBeenCalled();
    });

    it("works when Element Call calls a callback it took off the bridge", async () => {
        // The component reads `close` off the bridge to see whether it exists, and calls what it got
        const { close, notifyJoined } = bridge;
        await close();
        expect(call.handleClose).toHaveBeenCalled();
        await notifyJoined();
        expect(call.handleJoined).toHaveBeenCalled();
    });

    it("sets persistence when asked to stay on screen", async () => {
        await bridge.setAlwaysOnScreen(true);
        expect(setWidgetPersistence).toHaveBeenCalledWith(widgetId, roomId, true);
        await bridge.setAlwaysOnScreen(false);
        expect(setWidgetPersistence).toHaveBeenCalledWith(widgetId, roomId, false);
    });

    it("hangs up every other connected call before becoming persistent, but not when leaving the screen", async () => {
        const order: string[] = [];
        const otherCall = {
            disconnect: vi.fn(async () => {
                order.push("disconnect other");
            }),
        };
        const ownDisconnect = vi.fn(async () => {});
        (call as unknown as { disconnect: unknown }).disconnect = ownDisconnect;
        vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(
            new Set([call, otherCall] as unknown as Call[]),
        );
        setWidgetPersistence.mockImplementation(() => {
            order.push("persist");
        });

        await bridge.setAlwaysOnScreen(true);
        expect(order).toEqual(["disconnect other", "persist"]);
        expect(ownDisconnect).not.toHaveBeenCalled();

        await bridge.setAlwaysOnScreen(false);
        expect(otherCall.disconnect).toHaveBeenCalledTimes(1);
    });

    describe("voice channel switch warning", () => {
        let otherCall: { disconnect: ReturnType<typeof vi.fn> };
        let ownDisconnect: ReturnType<typeof vi.fn>;

        function warnBeforeSwitching(answer: boolean): ReturnType<typeof vi.spyOn> {
            vi.spyOn(SettingsStore, "getValue").mockImplementation(
                (name) => (name === "feature_desktop_shell" || name === "desktopVoiceSwitchWarning") as never,
            );
            return vi
                .spyOn(Modal, "createDialog")
                .mockReturnValue({ finished: Promise.resolve([answer]) } as unknown as ReturnType<
                    typeof Modal.createDialog
                >);
        }

        beforeEach(() => {
            otherCall = { disconnect: vi.fn(async () => {}) };
            ownDisconnect = vi.fn(async () => {});
            (call as unknown as { disconnect: unknown }).disconnect = ownDisconnect;
            vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(
                new Set([call, otherCall] as unknown as Call[]),
            );
        });

        it("leaves the old call and stays on screen when the user agrees", async () => {
            const dialog = warnBeforeSwitching(true);
            await bridge.setAlwaysOnScreen(true);
            expect(dialog).toHaveBeenCalledOnce();
            expect(otherCall.disconnect).toHaveBeenCalled();
            expect(setWidgetPersistence).toHaveBeenCalledWith(widgetId, roomId, true);
        });

        it("keeps the old call and abandons the new one when the user declines", async () => {
            warnBeforeSwitching(false);
            await bridge.setAlwaysOnScreen(true);
            expect(otherCall.disconnect).not.toHaveBeenCalled();
            expect(ownDisconnect).toHaveBeenCalledOnce();
            expect(setWidgetPersistence).not.toHaveBeenCalled();
        });

        it("does not ask when there is no other call", async () => {
            const dialog = warnBeforeSwitching(false);
            vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(new Set([call] as unknown as Call[]));
            await bridge.setAlwaysOnScreen(true);
            expect(dialog).not.toHaveBeenCalled();
            expect(setWidgetPersistence).toHaveBeenCalledWith(widgetId, roomId, true);
        });
    });

    it("still becomes persistent when another call cannot be disconnected", async () => {
        const failing = { disconnect: vi.fn(async () => Promise.reject(new Error("no hangup for you"))) };
        const fine = { disconnect: vi.fn(async () => {}) };
        vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(
            new Set([call, failing, fine] as unknown as Call[]),
        );
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

        // The rejection must neither escape to Element Call nor stop this call from becoming sticky:
        // there is nothing else to do for a call that will not hang up, and the delayed event will
        // clean its membership up eventually.
        await expect(bridge.setAlwaysOnScreen(true)).resolves.toBeUndefined();
        expect(fine.disconnect).toHaveBeenCalledTimes(1);
        expect(setWidgetPersistence).toHaveBeenCalledWith(widgetId, roomId, true);
        expect(warn).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ message: "no hangup for you" }),
        );
    });

    it("supports reactions and vouches for the intent, as Element Web's widget host does", () => {
        const hostBridge: ElementCallHostBridge = bridge;
        expect(hostBridge.supportsReactions).toBe(true);
        expect(hostBridge.allowJoinUnmutedViaIntent).toBe(true);
    });

    it("wires custom renderPresentation when provided for Aether desktop shell", () => {
        expect(bridge.renderPresentation).toBeUndefined();
        const renderPresentation = vi.fn(() => "custom-stage");
        const customBridge = new ElementWebHostBridge(call as unknown as ElementCall, {
            widgetId,
            widgetRoomId: roomId,
            renderPresentation,
        });
        const presentation = { state: {}, actions: {} };
        expect(customBridge.renderPresentation?.(presentation)).toBe("custom-stage");
        expect(renderPresentation).toHaveBeenCalledExactlyOnceWith(presentation);
    });
});
