/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PortalShortcutBackend } from "./PortalShortcutBackend.js";

const path = "/org/freedesktop/portal/desktop";
const session = `${path}/session/1_4/test`;
const iface = "org.freedesktop.portal.GlobalShortcuts";

describe("PortalShortcutBackend", () => {
    function fixture(deny = false) {
        const connection = Object.assign(new EventEmitter(), { stream: { destroy: vi.fn() } });
        let serial = 0;
        const bus = {
            connection,
            invoke: vi.fn((message: { member: string }, callback: (error: unknown, value: unknown) => void) => {
                if (message.member === "GetNameOwner") return callback(null, ":1.7");
                if (message.member === "Register" || message.member === "AddMatch" || message.member === "Close")
                    return callback(null, undefined);
                const requestPath = `${path}/request/1_4/${++serial}`;
                callback(null, requestPath);
                const dictionary =
                    message.member === "CreateSession"
                        ? [["session_handle", [[], [session]]]]
                        : [["shortcuts", [[], [[["push_to_talk", []]]]]]];
                // A reply and its signal can arrive in the same input batch.
                connection.emit("message", {
                    sender: ":1.7",
                    type: 4,
                    path: requestPath,
                    interface: "org.freedesktop.portal.Request",
                    member: "Response",
                    body: [deny ? 1 : 0, dictionary],
                });
            }),
        };
        const emit = vi.fn();
        const failed = vi.fn();
        const backend = new PortalShortcutBackend(
            emit,
            failed,
            bus as unknown as ConstructorParameters<typeof PortalShortcutBackend>[2],
        );
        return { backend, connection, bus, emit, failed };
    }
    it("should register only portal-confirmed IDs and deliver authenticated activation and deactivation", async () => {
        const f = fixture();
        expect(
            await f.backend.configure([
                { id: "push_to_talk", key: "Control+KeyV", kind: "hold" },
                { id: "toggle_mute", key: "KeyM", kind: "toggle" },
                { id: "push_to_mute", key: "AltLeft", kind: "hold" },
            ]),
        ).toEqual([
            { id: "push_to_talk", status: "registered" },
            { id: "toggle_mute", status: "conflict" },
            { id: "push_to_mute", status: "unsupported" },
        ]);
        const message = {
            type: 4,
            sender: ":1.7",
            path,
            interface: iface,
            member: "Activated",
            body: [session, "push_to_talk"],
        };
        f.connection.emit("message", { ...message, sender: ":1.9" });
        f.connection.emit("message", { ...message, body: [session, "arbitrary"] });
        expect(f.emit).not.toHaveBeenCalled();
        f.connection.emit("message", message);
        f.connection.emit("message", { ...message, member: "Deactivated" });
        expect(f.emit.mock.calls).toEqual([
            ["push_to_talk", true],
            ["push_to_talk", false],
        ]);
        f.connection.emit("message", {
            ...message,
            path: session,
            interface: "org.freedesktop.portal.Session",
            member: "Closed",
        });
        expect(f.failed).toHaveBeenCalledOnce();
        f.connection.emit("message", { ...message, member: "ShortcutsChanged", body: [session, []] });
        f.connection.emit("message", {
            type: 4,
            sender: "org.freedesktop.DBus",
            path: "/org/freedesktop/DBus",
            interface: "org.freedesktop.DBus",
            member: "NameOwnerChanged",
            body: ["org.freedesktop.portal.Desktop", ":1.7", ""],
        });
        expect(f.failed).toHaveBeenCalledTimes(3);
        f.backend.dispose();
        expect(f.connection.stream.destroy).toHaveBeenCalledOnce();
        expect(f.connection.listenerCount("message")).toBe(0);
    });
    it("should reject permission denial and let the controller report unsupported", async () => {
        const f = fixture(true);
        await expect(f.backend.configure([{ id: "push_to_talk", key: "KeyV", kind: "hold" }])).rejects.toThrow(
            "permission denied",
        );
        f.backend.dispose();
    });
});
