/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import dbus from "@homebridge/dbus-native";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { portalTrigger } from "./keys.js";
import { ACTION_IDS, type ActionId, type ShortcutBackend, type ShortcutBinding, type ShortcutResult } from "./types.js";

const destination = "org.freedesktop.portal.Desktop";
const path = "/org/freedesktop/portal/desktop";
const iface = "org.freedesktop.portal.GlobalShortcuts";
interface BusMessage {
    type?: number;
    sender?: string;
    path: string;
    interface: string;
    member: string;
    body?: unknown[];
}
interface PortalBus {
    connection: EventEmitter & { stream: Socket };
    invoke: (message: object, callback: (error: unknown, value: unknown) => void) => void;
}
interface RequestWaiter {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Release-aware shortcuts mediated by the compositor's user permission dialog. */
export class PortalShortcutBackend implements ShortcutBackend {
    public readonly name = "portal";
    private session?: string;
    private owner?: string;
    private disposed = false;
    private ready = false;
    private readonly requests = new Map<string, RequestWaiter>();
    private readonly responses = new Map<string, unknown[]>();
    private readonly bus: PortalBus;

    public constructor(
        private readonly emit: (id: ActionId, pressed: boolean) => void,
        private readonly failed: () => void,
        bus?: PortalBus,
        private readonly appId = "aether",
    ) {
        // The maintained dbus-native fork's published types omit sessionBus and low-level messages.
        this.bus = bus ?? (dbus as unknown as { sessionBus: () => PortalBus }).sessionBus();
        this.bus.connection.on("message", this.message);
        this.bus.connection.on("error", this.failed);
        this.bus.connection.on("end", this.failed);
    }

    public configure = async (bindings: ShortcutBinding[]): Promise<ShortcutResult["bindings"]> => {
        // Register this dedicated connection before using portals, so bindings belong to Aether.
        try {
            await this.call(
                "Register",
                "sa{sv}",
                [this.appId, []],
                destination,
                path,
                "org.freedesktop.host.portal.Registry",
            );
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !["org.freedesktop.DBus.Error.UnknownMethod", "org.freedesktop.DBus.Error.UnknownInterface"].includes(
                    error.name,
                )
            )
                throw error;
        }
        // Pin signals to the unique service owner, rather than trusting arbitrary bus peers.
        this.owner = await this.call(
            "GetNameOwner",
            "s",
            [destination],
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
        );
        await this.call(
            "AddMatch",
            "s",
            [`type='signal',sender='${this.owner}'`],
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
        );
        await this.call(
            "AddMatch",
            "s",
            [
                "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.portal.Desktop'",
            ],
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
        );
        const sessionToken = `aether_${randomBytes(12).toString("hex")}`;
        const created = await this.request("CreateSession", "a{sv}", [[["session_handle_token", ["s", sessionToken]]]]);
        this.session = this.variant(created, "session_handle") as string;
        if (typeof this.session !== "string" || !this.session.startsWith("/org/freedesktop/portal/desktop/session/")) {
            throw new Error("Invalid portal session");
        }
        const supported = bindings.filter((binding) => portalTrigger(binding.key));
        const bound = await this.request("BindShortcuts", "oa(sa{sv})sa{sv}", [
            this.session,
            supported.map((binding) => [
                binding.id,
                [
                    ["description", ["s", binding.id.replaceAll("_", " ")]],
                    ["preferred_trigger", ["s", portalTrigger(binding.key)]],
                ],
            ]),
            "",
            [],
        ]);
        this.ready = true;
        const shortcuts = this.variant(bound, "shortcuts");
        const ids = new Set(Array.isArray(shortcuts) ? shortcuts.map((entry: unknown[]) => entry[0]) : []);
        return bindings.map(({ id, key }) => ({
            id,
            status: !portalTrigger(key) ? "unsupported" : ids.has(id) ? "registered" : "conflict",
        }));
    };

    public dispose = (): void => {
        if (this.disposed) return;
        this.disposed = true;
        // Disconnecting also closes the session and any permission requests still in flight.
        if (this.session)
            this.bus.invoke(
                { destination, path: this.session, interface: "org.freedesktop.portal.Session", member: "Close" },
                () => {},
            );
        for (const waiter of this.requests.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error("Shortcut session closed"));
        }
        this.requests.clear();
        this.responses.clear();
        this.bus.connection.removeListener("message", this.message);
        this.bus.connection.removeListener("end", this.failed);
        this.bus.connection.stream.destroy();
        this.bus.connection.removeListener("error", this.failed);
    };

    private call(
        member: string,
        signature: string,
        body: unknown[],
        target = destination,
        objectPath = path,
        interfaceName = target === destination ? iface : target,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Portal call timed out")), 15000);
            this.bus.invoke(
                {
                    destination: target,
                    path: objectPath,
                    interface: interfaceName,
                    member,
                    signature,
                    body,
                },
                (error, value) => {
                    clearTimeout(timer);
                    if (error) {
                        const failure = new Error("Portal call failed");
                        if (
                            typeof error === "object" &&
                            error !== null &&
                            "name" in error &&
                            typeof error.name === "string"
                        )
                            failure.name = error.name;
                        reject(failure);
                    } else resolve(value as string);
                },
            );
        });
    }

    private async request(member: string, signature: string, body: unknown[]): Promise<unknown> {
        const requestPath = await this.call(member, signature, body);
        if (this.disposed) throw new Error("Shortcut session closed");
        return new Promise((resolve, reject) => {
            const response = this.responses.get(requestPath);
            if (response) {
                this.responses.delete(requestPath);
                if (response[0] === 0) resolve(response[1]);
                else reject(new Error("Shortcut permission denied"));
                return;
            }
            const timer = setTimeout(() => {
                this.requests.delete(requestPath);
                reject(new Error("Shortcut permission timed out"));
            }, 120000);
            this.requests.set(requestPath, { resolve, reject, timer });
        });
    }

    private message = (message: BusMessage): void => {
        if (this.disposed || message.type !== 4) return;
        if (
            message.sender === "org.freedesktop.DBus" &&
            message.interface === "org.freedesktop.DBus" &&
            message.member === "NameOwnerChanged" &&
            message.body?.[0] === destination &&
            message.body?.[1] === this.owner
        ) {
            this.failed();
            return;
        }
        if (message.sender !== this.owner) return;
        if (message.interface === "org.freedesktop.portal.Request" && message.member === "Response") {
            const response = message.body ?? [];
            const waiter = this.requests.get(message.path);
            if (waiter) {
                clearTimeout(waiter.timer);
                this.requests.delete(message.path);
                if (response[0] === 0) waiter.resolve(response[1]);
                else waiter.reject(new Error("Shortcut permission denied"));
            } else if (this.responses.size < 8) this.responses.set(message.path, response);
        }
        if (
            message.path === this.session &&
            message.interface === "org.freedesktop.portal.Session" &&
            message.member === "Closed"
        ) {
            this.failed();
        }
        if (message.interface !== iface || message.path !== path || message.body?.[0] !== this.session) return;
        if (message.member === "ShortcutsChanged") {
            if (this.ready) this.failed();
            return;
        }
        const id = message.body?.[1];
        if (typeof id !== "string" || !ACTION_IDS.includes(id as ActionId)) return;
        if (message.member === "Activated") this.emit(id as ActionId, true);
        if (message.member === "Deactivated") this.emit(id as ActionId, false);
    };

    private variant(dictionary: unknown, key: string): unknown {
        if (!Array.isArray(dictionary)) return;
        const entry = dictionary.find((item: unknown) => Array.isArray(item) && item[0] === key);
        // dbus-native decodes variants as [signature tree, [value]].
        return entry?.[1]?.[1]?.[0];
    }
}
