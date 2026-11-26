/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("@element-hq/element-call-component"), "utf8");

/** The text of the shipped bundle from `from` up to (not including) `to`. */
function slice(from: string, to: string): string {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

/** tslib's `__awaiter`, which the bundle's generator-based async methods run through. */
function awaiter(thisArg: unknown, _args: unknown, _p: unknown, generator: () => Generator): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const gen = generator.call(thisArg);
        const step = (next: () => IteratorResult<unknown>): void => {
            let result: IteratorResult<unknown>;
            try {
                result = next();
            } catch (error) {
                reject(error);
                return;
            }
            if (result.done) resolve(result.value);
            else
                Promise.resolve(result.value).then(
                    (value) => step(() => gen.next(value)),
                    (error) => step(() => gen.throw(error)),
                );
        };
        step(() => gen.next());
    });
}

const RoomEvent = { DataReceived: "dataReceived", ParticipantConnected: "participantConnected" };

interface Carrier {
    canReach(userId: string, deviceId: string): boolean;
    send(userId: string, deviceId: string, message: object): void;
}

function loadCarrier(): {
    aetherSealedTopic: string;
    aetherAttachCarrier: (room: unknown, client: unknown, session: unknown, log: unknown) => () => void;
} {
    return new Function(
        "q",
        `${slice("const aetherSealedTopic", "// Aether: sound triggers travel with the call")}; return { aetherSealedTopic, aetherAttachCarrier };`,
    )(RoomEvent);
}

describe("Element Call's fast lane", () => {
    const setup = () => {
        const { aetherAttachCarrier, aetherSealedTopic } = loadCarrier();
        const room = Object.assign(new EventEmitter(), {
            remoteParticipants: new Map([["@bob:x:BOB", {}]]),
            localParticipant: { publishData: vi.fn().mockResolvedValue(undefined) },
        });
        const client = { aetherReceiveCarriedToDevice: vi.fn().mockResolvedValue(undefined) };
        let carrier: Carrier | undefined;
        const session = {
            aetherSetCarrier: vi.fn((c: Carrier | undefined) => (carrier = c)),
            aetherOnReachable: vi.fn(),
        };
        const log = { info: vi.fn(), warn: vi.fn() };
        const detach = aetherAttachCarrier(room, client, session, log);
        return { room, client, session, detach, topic: aetherSealedTopic, carrier: () => carrier };
    };

    it("reaches the devices in the media room, by their LiveKit identity", () => {
        const { carrier } = setup();
        expect(carrier()!.canReach("@bob:x", "BOB")).toBe(true);
        expect(carrier()!.canReach("@bob:x", "OTHER")).toBe(false);
    });

    it("sends a sealed message reliably, to that device only, on its own topic", () => {
        const { carrier, room, topic } = setup();
        carrier()!.send("@bob:x", "BOB", { type: "m.room.encrypted", content: { ciphertext: "c" } });
        const [payload, options] = room.localParticipant.publishData.mock.calls[0]!;
        expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({
            type: "m.room.encrypted",
            content: { ciphertext: "c" },
        });
        expect(options).toEqual({ reliable: true, topic, destinationIdentities: ["@bob:x:BOB"] });
    });

    it("passes sealed messages to the client's crypto, naming the sender as LiveKit identified it", () => {
        const { room, client, topic } = setup();
        const message = { type: "m.room.encrypted", content: { ciphertext: "c" } };
        const payload = new TextEncoder().encode(JSON.stringify(message));
        room.emit(RoomEvent.DataReceived, payload, { identity: "@bob:x:BOB" }, 0, topic);
        expect(client.aetherReceiveCarriedToDevice).toHaveBeenCalledWith([{ ...message, sender: "@bob:x" }]);
    });

    it("takes a sealed message that arrives before the media room knows its sender, by the packet's identity", () => {
        const { room, client, topic } = setup();
        const message = { type: "m.room.encrypted", content: { ciphertext: "c" } };
        const payload = new TextEncoder().encode(JSON.stringify(message));
        room.emit(RoomEvent.DataReceived, payload, undefined, 0, topic);
        expect(client.aetherReceiveCarriedToDevice).not.toHaveBeenCalled();
        room.emit(RoomEvent.DataReceived, payload, undefined, 0, topic, 0, "@carol:x:CAROL");
        expect(client.aetherReceiveCarriedToDevice).toHaveBeenCalledWith([{ ...message, sender: "@carol:x" }]);
        // LiveKit passes that identity on with each user packet.
        const dispatch = slice("this.handleDataPacket = (e, t) => {", "this.handleSipDtmf = (e, t) => {");
        expect(dispatch).toContain("this.handleUserPacket(n, e.value.value, e.kind, t, e.participantIdentity)");
        expect(dispatch).toContain("this.emit(q.DataReceived, t.payload, e, n, t.topic, r, i)");
    });

    it.each([
        ["another topic", () => [{ type: "m.room.encrypted", content: {} }, "io.aether.soundboard"] as const],
        [
            "a message that is not Olm ciphertext",
            (topic: string) => [{ type: "io.aether.call.hello", content: {} }, topic] as const,
        ],
        ["something that is not JSON", (topic: string) => ["not json", topic] as const],
    ])("ignores %s", (_, make) => {
        const { room, client, topic } = setup();
        const [message, packetTopic] = make(topic);
        const text = typeof message === "string" ? message : JSON.stringify(message);
        room.emit(RoomEvent.DataReceived, new TextEncoder().encode(text), { identity: "@bob:x:BOB" }, 0, packetTopic);
        expect(client.aetherReceiveCarriedToDevice).not.toHaveBeenCalled();
    });

    it("tells the session about devices arriving in the media room", () => {
        const { room, session } = setup();
        room.emit(RoomEvent.ParticipantConnected, { identity: "@carol:x:CAROL" });
        expect(session.aetherOnReachable).toHaveBeenCalledWith("@carol:x", "CAROL");
    });

    it("closes the fast lane when detached", () => {
        const { room, session, client, topic, detach } = setup();
        detach();
        expect(session.aetherSetCarrier).toHaveBeenLastCalledWith(undefined);
        room.emit(RoomEvent.DataReceived, new Uint8Array(), { identity: "@bob:x:BOB" }, 0, topic);
        room.emit(RoomEvent.ParticipantConnected, { identity: "@carol:x:CAROL" });
        expect(client.aetherReceiveCarriedToDevice).not.toHaveBeenCalled();
        expect(session.aetherOnReachable).not.toHaveBeenCalled();
    });

    it("does nothing with a session or client that has no fast lane", () => {
        const { aetherAttachCarrier } = loadCarrier();
        const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(), localParticipant: {} });
        aetherAttachCarrier(room, {}, {}, { info: vi.fn(), warn: vi.fn() })();
        expect(room.listenerCount(RoomEvent.DataReceived)).toBe(0);
    });

    it("lets sealed messages skip LiveKit's own data encryption, and nothing else", () => {
        const send = slice("\tsendDataPacket(e, t) {", "\t\t\tt === My.RELIABLE && (e.sequence");
        expect(send).toContain('!(e.value?.case === "user" && e.value.value?.topic === aetherSealedTopic)');
    });
});

describe("LiveKit's data connection after a failed attempt", () => {
    const load = (): { ensurePublisherConnected(this: unknown, kind: number): Promise<void> } =>
        new Function("K", `return { ${slice("ensurePublisherConnected(e) {", "\tverifyTransport() {")} };`)(awaiter);

    it("tries again on the next message instead of failing every later one", async () => {
        const engine = Object.assign(load(), {
            publisherConnectionPromise: undefined as Promise<void> | undefined,
            ensureDataTransportConnected: vi
                .fn()
                .mockRejectedValueOnce(new Error("PC manager is closed"))
                .mockResolvedValue(undefined),
        });
        await expect(engine.ensurePublisherConnected(0)).rejects.toThrow("PC manager is closed");
        await expect(engine.ensurePublisherConnected(0)).resolves.toBeUndefined();
        expect(engine.ensureDataTransportConnected).toHaveBeenCalledTimes(2);
        // A connection that worked is kept.
        await engine.ensurePublisherConnected(0);
        expect(engine.ensureDataTransportConnected).toHaveBeenCalledTimes(2);
    });
});
