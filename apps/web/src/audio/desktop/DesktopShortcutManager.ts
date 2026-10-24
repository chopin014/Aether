/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import { formatPushToTalkKey, parsePushToTalkKey } from "./PushToTalk";

/** The fixed actions supported by the desktop shortcut bridge. */
export const DESKTOP_SHORTCUT_ACTIONS = [
    "push_to_talk",
    "push_to_mute",
    "toggle_mute",
    "toggle_deafen",
    "toggle_input_mode",
    "show_hide",
] as const;
/** A shortcut action supported by the renderer and desktop host. */
export type DesktopShortcutAction = (typeof DESKTOP_SHORTCUT_ACTIONS)[number];
/** Registration state, including local validation and browser focus limitations. */
export type DesktopShortcutStatus =
    | "registered"
    | "conflict"
    | "unsupported"
    | "invalid"
    | "unbound"
    | "focused"
    | "paused";
/** A press, release, or safety reset from the desktop host. */
export interface DesktopShortcutEvent {
    id: string;
    pressed: boolean;
    reset?: boolean;
}
/** Sandboxed desktop shortcut bridge; key names follow KeyboardEvent.code. */
export interface GlobalShortcutApi {
    configure(configuration: {
        enabled: boolean;
        bindings: Array<{ id: string; key: string; kind: "hold" | "toggle" }>;
    }): Promise<{
        backend: "native" | "portal" | "unsupported";
        bindings: Array<{ id: string; status: "registered" | "conflict" | "unsupported" | "invalid" }>;
    }>;
    onEvent(listener: (event: DesktopShortcutEvent) => void): () => void;
}

/** Validates and canonicalizes the common renderer/native key notation. */
export function normalizeDesktopShortcut(key: string): string | null {
    if (!key) return "";
    const parts = key.split("+");
    const code = parts.pop()!;
    if (
        !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad[0-9]|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|CapsLock|Pause|ScrollLock|PrintScreen|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|(Control|Alt|Shift|Meta)(Left|Right))$/.test(
            code,
        )
    )
        return null;
    if (
        parts.some((part) => !["Control", "Alt", "Shift", "Meta"].includes(part)) ||
        new Set(parts).size !== parts.length
    )
        return null;
    return formatPushToTalkKey(parsePushToTalkKey(key)!);
}

/**
 * One session owner registers shortcuts; settings and microphone gates subscribe without owning registrations.
 * All configuration updates are serialized, so recording/disposal cannot be overtaken by an older registration.
 */
export class DesktopShortcutManager {
    public static readonly instance = new DesktopShortcutManager();
    private owners = 0;
    private recording = 0;
    private generation = 0;
    private watchers: string[] = [];
    private unsubscribe?: () => void;
    private queue = Promise.resolve();
    private readonly held = new Set<DesktopShortcutAction>();
    private readonly listeners = new Set<(event: DesktopShortcutEvent) => void>();
    private readonly changes = new Set<() => void>();
    private statuses: Partial<Record<DesktopShortcutAction, DesktopShortcutStatus>> = {};
    private backend: "native" | "portal" | "unsupported" | "focused" = "focused";

    public constructor(
        private readonly target: Window = window,
        private readonly api = target.electron?.globalShortcuts,
    ) {}

    public getBackend = (): string => this.backend;
    public getStatus = (id: DesktopShortcutAction): DesktopShortcutStatus => this.statuses[id] ?? "unbound";
    public getKey = (id: DesktopShortcutAction): string =>
        id === "push_to_talk"
            ? SettingsStore.getValue("desktopPushToTalkKey")
            : (SettingsStore.getValue("desktopShortcutBindings")[id] ?? "");
    public subscribe = (listener: () => void): (() => void) => {
        this.changes.add(listener);
        return () => this.changes.delete(listener);
    };
    public onEvent = (listener: (event: DesktopShortcutEvent) => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    public setKey = async (id: DesktopShortcutAction, key: string): Promise<void> => {
        const normalized = normalizeDesktopShortcut(key);
        if (normalized === null) throw new Error("Invalid shortcut");
        if (id === "push_to_talk")
            await SettingsStore.setValue("desktopPushToTalkKey", null, SettingLevel.DEVICE, normalized);
        else
            await SettingsStore.setValue("desktopShortcutBindings", null, SettingLevel.DEVICE, {
                ...SettingsStore.getValue("desktopShortcutBindings"),
                [id]: normalized,
            });
    };
    /** Starts a session owner. Its cleanup unregisters everything when the last owner leaves. */
    public start = (): (() => void) => {
        if (++this.owners === 1) {
            this.watchers = (
                [
                    "feature_desktop_shell",
                    "desktopShortcutBindings",
                    "desktopPushToTalkKey",
                    "desktopInputMode",
                ] as const
            ).map((name) => SettingsStore.watchSetting(name, null, this.refresh));
            this.unsubscribe = this.api?.onEvent(this.receive);
            this.target.addEventListener("keydown", this.keyDown);
            this.target.addEventListener("keyup", this.keyUp);
            this.target.addEventListener("blur", this.blur);
            this.refresh();
        }
        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            if (--this.owners) return;
            this.watchers.forEach((id) => SettingsStore.unwatchSetting(id));
            this.watchers = [];
            this.unsubscribe?.();
            this.target.removeEventListener("keydown", this.keyDown);
            this.target.removeEventListener("keyup", this.keyUp);
            this.target.removeEventListener("blur", this.blur);
            this.refresh();
        };
    };
    /** Recording suspends all native and focused actions, including the existing voice-settings recorder. */
    public suspend = (): (() => void) => {
        this.recording++;
        this.refresh();
        let resumed = false;
        return () => {
            if (resumed) return;
            resumed = true;
            this.recording--;
            this.refresh();
        };
    };
    private emit(event: DesktopShortcutEvent): void {
        for (const listener of this.listeners) listener(event);
    }
    private reset(): void {
        for (const id of this.held) this.emit({ id, pressed: false, reset: true });
        this.held.clear();
        // Reset also cancels a PTT release-delay timer after the physical key was already released.
        this.emit({ id: "push_to_talk", pressed: false, reset: true });
        this.emit({ id: "push_to_mute", pressed: false, reset: true });
    }
    private enabled(): boolean {
        return this.owners > 0 && !this.recording && SettingsStore.getValue("feature_desktop_shell");
    }
    private readonly refresh = (): void => {
        const generation = ++this.generation;
        this.reset();
        const keys = DESKTOP_SHORTCUT_ACTIONS.map((id) => ({ id, key: this.getKey(id) }));
        const bindings: Array<{ id: string; key: string; kind: "hold" | "toggle" }> = [];
        this.statuses = {};
        for (const { id, key } of keys) {
            const normalized = normalizeDesktopShortcut(key);
            let status: DesktopShortcutStatus = !key ? "unbound" : normalized === null ? "invalid" : "paused";
            if (
                key &&
                normalized &&
                keys.some((other) => other.id !== id && normalizeDesktopShortcut(other.key) === normalized)
            )
                status = "conflict";
            if (status === "paused" && this.enabled()) {
                status = this.api ? "paused" : id === "show_hide" ? "unsupported" : "focused";
                bindings.push({ id, key: normalized!, kind: id.startsWith("push_") ? "hold" : "toggle" });
            }
            this.statuses[id] = status;
        }
        this.notify();
        if (!this.api) return;
        this.queue = this.queue.then(async () => {
            if (generation !== this.generation) return;
            try {
                const result = await this.api!.configure({ enabled: this.enabled(), bindings });
                if (generation !== this.generation) return;
                this.backend = result.backend;
                for (const binding of bindings) {
                    const row = result.bindings.find((row) => row.id === binding.id);
                    this.statuses[binding.id as DesktopShortcutAction] =
                        result.backend === "unsupported" ? "unsupported" : (row?.status ?? "unsupported");
                }
            } catch {
                if (generation !== this.generation) return;
                this.backend = "unsupported";
                for (const { id } of bindings) this.statuses[id as DesktopShortcutAction] = "unsupported";
                this.reset();
            }
            this.notify();
        });
    };
    private notify(): void {
        for (const listener of this.changes) listener();
    }
    private readonly receive = (event: DesktopShortcutEvent): void => {
        if (!DESKTOP_SHORTCUT_ACTIONS.includes(event.id as DesktopShortcutAction)) return;
        const id = event.id as DesktopShortcutAction;
        if (event.reset) {
            this.reset();
            return;
        }
        if (!this.enabled() || !this.getKey(id) || !["registered", "focused"].includes(this.getStatus(id))) return;
        if (id === "show_hide") return; // The native host owns the actual window action.
        if (event.pressed) {
            if (this.held.has(id)) return;
            this.held.add(id);
        } else if (!this.held.delete(id)) return;
        this.emit(event);
    };
    private readonly keyDown = (event: KeyboardEvent): void => {
        if (this.api || event.repeat || event.defaultPrevented || !this.enabled()) return;
        const target = event.target as HTMLElement | null;
        if (target?.isContentEditable || target?.closest?.("input,textarea,select")) return;
        for (const id of DESKTOP_SHORTCUT_ACTIONS) {
            const binding = parsePushToTalkKey(this.getKey(id));
            if (!binding || binding.code !== event.code) continue;
            const modifier = /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(binding.code);
            if (
                !modifier &&
                (binding.ctrl !== event.ctrlKey ||
                    binding.alt !== event.altKey ||
                    binding.shift !== event.shiftKey ||
                    binding.meta !== event.metaKey)
            )
                continue;
            if (this.getStatus(id) !== "focused") continue;
            event.preventDefault();
            this.receive({ id, pressed: true });
        }
    };
    private readonly keyUp = (event: KeyboardEvent): void => {
        if (this.api) return;
        for (const id of this.held)
            if (parsePushToTalkKey(this.getKey(id))?.code === event.code) this.receive({ id, pressed: false });
    };
    private readonly blur = (): void => {
        if (!this.api) this.reset();
    };
}
