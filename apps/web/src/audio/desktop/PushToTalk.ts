/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** A push to talk key: a `KeyboardEvent.code` with the modifiers that must be held, e.g. "Control+KeyV". */
export interface PushToTalkBinding {
    code: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
}

const MODIFIER_CODES = [
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "ShiftLeft",
    "ShiftRight",
    "MetaLeft",
    "MetaRight",
];

/** Whether a key code is itself a modifier, which may be bound on its own. */
export function isModifierCode(code: string): boolean {
    return MODIFIER_CODES.includes(code);
}

/** Reads a stored binding such as "Control+KeyV"; null when nothing usable is stored. */
export function parsePushToTalkKey(value: string): PushToTalkBinding | null {
    const parts = value.split("+").filter(Boolean);
    const code = parts.pop();
    if (!code) return null;
    return {
        code,
        ctrl: parts.includes("Control"),
        alt: parts.includes("Alt"),
        shift: parts.includes("Shift"),
        meta: parts.includes("Meta"),
    };
}

/** Writes a binding in the form {@link parsePushToTalkKey} reads, modifiers first in a fixed order. */
export function formatPushToTalkKey(binding: PushToTalkBinding): string {
    return [
        binding.ctrl && "Control",
        binding.alt && "Alt",
        binding.shift && "Shift",
        binding.meta && "Meta",
        binding.code,
    ]
        .filter(Boolean)
        .join("+");
}

/** The binding a key press stands for, or null for a bare modifier, which only counts once it is released. */
export function pushToTalkBindingFromEvent(event: KeyboardEvent): PushToTalkBinding | null {
    if (isModifierCode(event.code)) return null;
    return { code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
}

/** The binding for a modifier key that was pressed and released without another key. */
export function pushToTalkBindingFromModifier(code: string): PushToTalkBinding {
    return { code, ctrl: false, alt: false, shift: false, meta: false };
}

/** A short label for a key code, e.g. "KeyV" is "V" and "ControlLeft" is "Left Ctrl". */
function describeCode(code: string): string {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
    const side = /^(Control|Alt|Shift|Meta)(Left|Right)$/.exec(code);
    if (side) return `${side[2]} ${side[1] === "Control" ? "Ctrl" : side[1]}`;
    return code.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** A readable form of a stored binding, such as "Ctrl + V". Empty when nothing is bound. */
export function describePushToTalkKey(value: string): string {
    const binding = parsePushToTalkKey(value);
    if (!binding) return "";
    return [
        binding.ctrl && "Ctrl",
        binding.alt && "Alt",
        binding.shift && "Shift",
        binding.meta && "Meta",
        describeCode(binding.code),
    ]
        .filter(Boolean)
        .join(" + ");
}

function matches(binding: PushToTalkBinding, event: KeyboardEvent): boolean {
    if (event.code !== binding.code) return false;
    if (isModifierCode(binding.code)) return true;
    return (
        event.ctrlKey === binding.ctrl &&
        event.altKey === binding.alt &&
        event.shiftKey === binding.shift &&
        event.metaKey === binding.meta
    );
}

/** Whether pressing this key would type into the focused element, so a bare letter must not trigger push to talk. */
function typesText(event: KeyboardEvent, binding: PushToTalkBinding): boolean {
    if (binding.ctrl || binding.alt || binding.meta || isModifierCode(binding.code) || /^F\d+$/.test(binding.code)) {
        return false;
    }
    const target = event.target as HTMLElement | null;
    return !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/**
 * Follows the push to talk key and says when the microphone should be open. It only sees key presses while
 * this window is focused: Electron's global shortcuts report a press but never the release, so they cannot
 * hold a microphone open.
 *
 * The microphone stays open for `releaseDelayMs` after the key is let go, and pressing the key again in that
 * time keeps it open without a gap. Losing focus closes it at once, because the release would never arrive.
 */
export class PushToTalkController {
    private binding: PushToTalkBinding | null = null;
    private releaseDelayMs = 0;
    private running = false;
    private pressed = false;
    private _active = false;
    private releaseTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly listeners = new Set<(active: boolean) => void>();

    public constructor(private readonly target: Pick<Window, "addEventListener" | "removeEventListener"> = window) {}

    /** Whether the microphone should be open. */
    public get active(): boolean {
        return this._active;
    }

    public onChange(listener: (active: boolean) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Sets the key and delay; an empty key means nothing is bound, and releases the microphone. */
    public configure(key: string, releaseDelayMs: number): void {
        this.binding = parsePushToTalkKey(key);
        this.releaseDelayMs = Math.max(0, releaseDelayMs);
        if (!this.binding) this.release();
    }

    public start(): void {
        if (this.running) return;
        this.running = true;
        this.target.addEventListener("keydown", this.onKeyDown as EventListener);
        this.target.addEventListener("keyup", this.onKeyUp as EventListener);
        this.target.addEventListener("blur", this.onBlur);
    }

    public stop(): void {
        if (!this.running) return;
        this.running = false;
        this.target.removeEventListener("keydown", this.onKeyDown as EventListener);
        this.target.removeEventListener("keyup", this.onKeyUp as EventListener);
        this.target.removeEventListener("blur", this.onBlur);
        this.release();
    }

    private setActive(active: boolean): void {
        if (this._active === active) return;
        this._active = active;
        for (const listener of this.listeners) listener(active);
    }

    private release(): void {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = undefined;
        this.pressed = false;
        this.setActive(false);
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (!this.binding || event.repeat || !matches(this.binding, event) || typesText(event, this.binding)) return;
        clearTimeout(this.releaseTimer);
        this.releaseTimer = undefined;
        this.pressed = true;
        this.setActive(true);
    };

    private readonly onKeyUp = (event: KeyboardEvent): void => {
        // Only the key's own release counts, so the modifiers may be let go of first.
        if (!this.binding || !this.pressed || event.code !== this.binding.code) return;
        this.pressed = false;
        if (this.releaseDelayMs === 0) {
            this.setActive(false);
            return;
        }
        this.releaseTimer = setTimeout(() => {
            this.releaseTimer = undefined;
            this.setActive(false);
        }, this.releaseDelayMs);
    };

    private readonly onBlur = (): void => this.release();
}
