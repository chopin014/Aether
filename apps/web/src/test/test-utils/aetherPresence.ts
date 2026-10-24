/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { vi, type Mock } from "vitest";
import { type MatrixClient, TypedEventEmitter } from "matrix-js-sdk/src/matrix";

export interface FakeRoomSpec {
    id: string;
    /** Joined member IDs, which may include the account itself. */
    members: string[];
    myMembership?: string;
}

/** A minimal client double for the Aether presence units. Test-only. */
export function makeFakeClient(
    opts: {
        userId?: string;
        rooms?: FakeRoomSpec[];
        direct?: Record<string, string[]>;
        ignored?: string[];
        crypto?: object | null;
    } = {},
): MatrixClient & TypedEventEmitter<string, Record<string, (...args: never[]) => void>> {
    const userId = opts.userId ?? "@me:example.org";
    const specs = opts.rooms ?? [];
    const rooms = specs.map((spec) => ({
        roomId: spec.id,
        getMyMembership: () => spec.myMembership ?? "join",
        getJoinedMemberCount: () => spec.members.length,
        getJoinedMembers: () => spec.members.map((m) => ({ userId: m, membership: "join" })),
        getMember: (id: string) => (spec.members.includes(id) ? { userId: id, membership: "join" } : null),
    }));
    const emitter = new TypedEventEmitter<string, Record<string, (...args: never[]) => void>>();
    return Object.assign(emitter, {
        getUserId: () => userId,
        getSafeUserId: () => userId,
        getRooms: () => rooms,
        getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
        getAccountData: (type: string) =>
            type === "m.direct" && opts.direct ? { getContent: () => opts.direct } : undefined,
        getIgnoredUsers: () => opts.ignored ?? [],
        getCrypto: () => (opts.crypto === undefined ? null : opts.crypto),
        queueToDevice: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        isGuest: () => false,
    }) as unknown as MatrixClient & TypedEventEmitter<string, Record<string, (...args: never[]) => void>>;
}

type GetDevices = (userIds: string[]) => Promise<Map<string, Map<string, unknown>>>;
type Encrypt = (
    eventType: string,
    devices: { userId: string; deviceId: string }[],
    payload: unknown,
) => Promise<{ eventType: string; batch: unknown[] }>;

export interface FakeCrypto {
    getUserDeviceInfo: Mock<GetDevices>;
    encryptToDeviceMessages: Mock<Encrypt>;
}

/** A crypto double with one device per user that encrypts into one message per device. */
export function makeFakeCrypto(devicesByUser: Record<string, string[]> = {}): FakeCrypto {
    return {
        getUserDeviceInfo: vi.fn<GetDevices>(
            async (userIds: string[]) =>
                new Map(
                    userIds.map((u) => [
                        u,
                        new Map((devicesByUser[u] ?? ["DEV"]).map((d) => [d, { deviceId: d, dehydrated: false }])),
                    ]),
                ),
        ),
        encryptToDeviceMessages: vi.fn<Encrypt>(
            async (eventType: string, devices: { userId: string; deviceId: string }[], payload: unknown) => ({
                eventType: "m.room.encrypted",
                batch: devices.map((d) => ({ ...d, payload: { wrapped: eventType, content: payload } })),
            }),
        ),
    };
}
