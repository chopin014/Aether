/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "test-utils-rtl";
import { EventType, type MatrixClient, MatrixEvent, Room, RoomMember, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { type CryptoApi, CryptoEvent, UserVerificationStatus } from "matrix-js-sdk/src/crypto-api";
import { logger } from "matrix-js-sdk/src/logger";
import { stubClient } from "test-utils";

import { useEncryptionStatus } from "./useEncryptionStatus";
import { E2EStatus, shieldStatusForRoom } from "../utils/ShieldUtils";

vi.mock("../utils/ShieldUtils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/ShieldUtils")>()),
    shieldStatusForRoom: vi.fn(),
}));

describe("useEncryptionStatus", () => {
    let client: MatrixClient;
    let room: Room;
    const checkEncryption = vi.fn<CryptoApi["isEncryptionEnabledInRoom"]>();

    beforeEach(() => {
        vi.useFakeTimers();
        client = stubClient();
        room = new Room("!room:server", client, "@alice:server");
        checkEncryption.mockReset().mockResolvedValue(false);
        vi.spyOn(client.getCrypto()!, "isEncryptionEnabledInRoom").mockImplementation(checkEncryption);
        vi.mocked(shieldStatusForRoom).mockReset().mockResolvedValue(E2EStatus.Normal);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const flush = async (): Promise<void> => {
        await act(async () => {
            await Promise.resolve();
        });
    };

    const advance = async (): Promise<void> => {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
        });
    };

    it("never loads a public room's trust shield or members, including on trust and membership events", async () => {
        const check = Promise.withResolvers<boolean>();
        checkEncryption.mockReturnValueOnce(check.promise);
        const members = vi.spyOn(room, "getEncryptionTargetMembers");
        const { result } = renderHook(() => useEncryptionStatus(client, room));
        expect(result.current).toBeNull();
        expect(shieldStatusForRoom).not.toHaveBeenCalled();
        await act(async () => check.resolve(false));

        act(() => {
            client.emit(CryptoEvent.DevicesUpdated, [], false);
            client.emit(
                CryptoEvent.UserTrustStatusChanged,
                "@other:server",
                new UserVerificationStatus(false, true, true),
            );
            room.emit(
                RoomStateEvent.Members,
                new MatrixEvent({ type: EventType.RoomMember }),
                room.currentState,
                new RoomMember(room.roomId, "@other:server"),
            );
        });
        await advance();

        expect(checkEncryption).toHaveBeenCalledTimes(2);
        expect(shieldStatusForRoom).not.toHaveBeenCalled();
        expect(members).not.toHaveBeenCalled();
        expect(result.current).toBeNull();
    });

    it("refreshes an encrypted room's shield when devices change", async () => {
        checkEncryption.mockResolvedValue(true);
        const { result } = renderHook(() => useEncryptionStatus(client, room));
        await flush();
        expect(result.current).toBe(E2EStatus.Normal);
        expect(shieldStatusForRoom).toHaveBeenCalledWith(client, room);

        vi.mocked(shieldStatusForRoom).mockResolvedValue(E2EStatus.Verified);
        act(() => {
            client.emit(CryptoEvent.DevicesUpdated, [], false);
        });
        await advance();

        expect(result.current).toBe(E2EStatus.Verified);
        expect(shieldStatusForRoom).toHaveBeenCalledTimes(2);

        vi.mocked(shieldStatusForRoom).mockResolvedValue(E2EStatus.Warning);
        act(() => {
            client.emit(
                CryptoEvent.UserTrustStatusChanged,
                "@other:server",
                new UserVerificationStatus(false, true, true),
            );
        });
        await advance();
        expect(result.current).toBe(E2EStatus.Warning);
        expect(shieldStatusForRoom).toHaveBeenCalledTimes(3);
    });

    it("starts shield evaluation if encryption is enabled after the room mounts", async () => {
        const { result } = renderHook(() => useEncryptionStatus(client, room));
        await flush();
        expect(shieldStatusForRoom).not.toHaveBeenCalled();

        checkEncryption.mockResolvedValue(true);
        act(() => {
            room.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomEncryption,
                    state_key: "",
                    room_id: room.roomId,
                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                }),
            ]);
        });
        await advance();

        expect(result.current).toBe(E2EStatus.Normal);
        expect(shieldStatusForRoom).toHaveBeenCalledTimes(1);
    });

    it("discards a previous room's pending shield and clears its displayed status", async () => {
        checkEncryption.mockResolvedValue(true);
        const pendingShield = Promise.withResolvers<E2EStatus>();
        const { result, rerender } = renderHook(({ currentRoom }) => useEncryptionStatus(client, currentRoom), {
            initialProps: { currentRoom: room },
        });
        await flush();
        expect(result.current).toBe(E2EStatus.Normal);

        vi.mocked(shieldStatusForRoom).mockReturnValueOnce(pendingShield.promise);
        act(() => {
            client.emit(CryptoEvent.DevicesUpdated, [], false);
        });
        await advance();
        expect(shieldStatusForRoom).toHaveBeenCalledTimes(2);

        const nextCheck = Promise.withResolvers<boolean>();
        checkEncryption.mockReturnValueOnce(nextCheck.promise);
        rerender({ currentRoom: new Room("!public:server", client, "@alice:server") });
        expect(result.current).toBeNull();
        await act(async () => pendingShield.resolve(E2EStatus.Warning));
        expect(result.current).toBeNull();
        await act(async () => nextCheck.resolve(false));
        expect(result.current).toBeNull();
        expect(shieldStatusForRoom).toHaveBeenCalledTimes(2);
    });

    it("does not start a shield when an old encryption check resolves after changing rooms", async () => {
        const oldCheck = Promise.withResolvers<boolean>();
        checkEncryption.mockReturnValueOnce(oldCheck.promise);
        const { result, rerender } = renderHook(({ currentRoom }) => useEncryptionStatus(client, currentRoom), {
            initialProps: { currentRoom: room },
        });
        rerender({ currentRoom: new Room("!public:server", client, "@alice:server") });
        await act(async () => oldCheck.resolve(true));

        expect(result.current).toBeNull();
        expect(shieldStatusForRoom).not.toHaveBeenCalled();
    });

    it("cancels queued refreshes and ignores pending results after unmount", async () => {
        checkEncryption.mockResolvedValue(true);
        const pendingShield = Promise.withResolvers<E2EStatus>();
        vi.mocked(shieldStatusForRoom).mockReturnValueOnce(pendingShield.promise);
        const stateListeners = room.currentState.listenerCount(RoomStateEvent.Events);
        const { unmount } = renderHook(() => useEncryptionStatus(client, room));
        await flush();
        act(() => {
            client.emit(CryptoEvent.DevicesUpdated, [], false);
        });

        unmount();
        act(() => {
            client.emit(CryptoEvent.DevicesUpdated, [], false);
        });
        await act(async () => pendingShield.resolve(E2EStatus.Warning));
        await advance();
        expect(checkEncryption).toHaveBeenCalledTimes(1);
        expect(shieldStatusForRoom).toHaveBeenCalledTimes(1);
        expect(room.listenerCount(RoomStateEvent.Members)).toBe(0);
        expect(room.currentState.listenerCount(RoomStateEvent.Events)).toBe(stateListeners);
    });

    it("handles encryption and shield failures and allows a later refresh", async () => {
        const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
        checkEncryption.mockRejectedValueOnce(new Error("crypto unavailable"));
        const { result } = renderHook(() => useEncryptionStatus(client, room));
        await flush();
        expect(result.current).toBeNull();
        expect(warning).toHaveBeenCalledTimes(1);

        checkEncryption.mockResolvedValue(true);
        vi.mocked(shieldStatusForRoom).mockRejectedValueOnce(new Error("members unavailable"));
        act(() => {
            client.emit(CryptoEvent.DevicesUpdated, [], false);
        });
        await advance();
        expect(result.current).toBeNull();
        expect(warning).toHaveBeenCalledTimes(2);

        act(() => {
            client.emit(CryptoEvent.DevicesUpdated, [], false);
        });
        await advance();
        expect(result.current).toBe(E2EStatus.Normal);
    });

    it("leaves rooms without crypto support unloaded", async () => {
        vi.mocked(client.getCrypto).mockReturnValue(undefined);
        const { result } = renderHook(() => useEncryptionStatus(client, room));
        await flush();

        expect(result.current).toBeNull();
        expect(checkEncryption).not.toHaveBeenCalled();
        expect(shieldStatusForRoom).not.toHaveBeenCalled();
    });
});
