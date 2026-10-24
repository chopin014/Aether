/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { UiohookKeyboardEvent, uIOhook, UiohookKey } from "uiohook-napi";
import { nativeAccelerator, parseKey } from "./keys.js";
import type { ActionId, ShortcutBackend, ShortcutBinding, ShortcutResult } from "./types.js";

type Hook = typeof uIOhook;
type KeyMap = typeof UiohookKey;
interface Registrar {
    register: (accelerator: string, listener: () => void) => boolean;
    unregister: (accelerator: string) => void;
}
/** Observe both hold edges without consuming input; reserve configured toggle shortcuts. */
export class NativeShortcutBackend implements ShortcutBackend {
    public readonly name = "native";
    private readonly registered: string[] = [];
    private bindings: ShortcutBinding[] = [];
    private readonly pressed = new Set<number>();
    private started = false;

    public constructor(
        private readonly hook: Hook,
        private readonly keyMap: KeyMap,
        private readonly registrar: Registrar,
        private readonly emit: (id: ActionId, pressed: boolean) => void,
        private readonly failed: () => void,
    ) {}

    public configure = async (bindings: ShortcutBinding[]): Promise<ShortcutResult["bindings"]> => {
        this.hook.on("keydown", this.down);
        this.hook.on("keyup", this.up);
        this.hook.addListener("error", this.failed);
        // Missing X11 libraries/displays must be checked by the factory before starting libuiohook.
        this.hook.start();
        this.started = true;
        return bindings.map((binding) => {
            const accelerator = nativeAccelerator(binding.key);
            if (!accelerator || !this.keyCode(parseKey(binding.key)!.code))
                return { id: binding.id, status: "unsupported" };
            if (!this.registrar.register(accelerator, () => {})) return { id: binding.id, status: "conflict" };
            if (binding.kind === "hold") {
                // Probe existing reservations, then let the focused game/editor receive the same key.
                this.registrar.unregister(accelerator);
            } else {
                this.registered.push(accelerator);
            }
            this.bindings.push(binding);
            return { id: binding.id, status: "registered" };
        });
    };

    public dispose = (): void => {
        this.bindings = [];
        this.pressed.clear();
        for (const accelerator of this.registered.splice(0)) this.registrar.unregister(accelerator);
        this.hook.removeListener("keydown", this.down);
        this.hook.removeListener("keyup", this.up);
        this.hook.removeListener("error", this.failed);
        if (this.started) {
            this.started = false;
            this.hook.stop();
        }
    };

    private down = (event: UiohookKeyboardEvent): void => {
        if (this.pressed.has(event.keycode)) return;
        this.pressed.add(event.keycode);
        this.evaluate(event.keycode, true);
    };
    private up = (event: UiohookKeyboardEvent): void => {
        this.pressed.delete(event.keycode);
        this.evaluate(event.keycode, false);
    };

    private evaluate(keycode: number, down: boolean): void {
        const modifiers: Record<string, boolean> = {
            Control: this.pressed.has(this.keyMap.Ctrl) || this.pressed.has(this.keyMap.CtrlRight),
            Alt: this.pressed.has(this.keyMap.Alt) || this.pressed.has(this.keyMap.AltRight),
            Shift: this.pressed.has(this.keyMap.Shift) || this.pressed.has(this.keyMap.ShiftRight),
            Meta: this.pressed.has(this.keyMap.Meta) || this.pressed.has(this.keyMap.MetaRight),
        };
        for (const binding of this.bindings) {
            const parsed = parseKey(binding.key)!;
            const active =
                this.pressed.has(this.keyCode(parsed.code)!) &&
                Object.entries(modifiers).every(([name, pressed]) => pressed === parsed.modifiers.includes(name));
            if (binding.kind === "hold" || !active || (down && keycode === this.keyCode(parsed.code))) {
                this.emit(binding.id, active);
            }
        }
    }

    private keyCode(code: string): number | undefined {
        const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code;
        return (this.keyMap as Record<string, number>)[key];
    }
}
