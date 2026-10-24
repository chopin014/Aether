/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ACTION_IDS,
    type ActionId,
    type BackendFactory,
    type ShortcutBackend,
    type ShortcutBinding,
    type ShortcutConfiguration,
    type ShortcutEvent,
    type ShortcutResult,
} from "./types.js";
import { parseKey } from "./keys.js";

/** Validate the complete IPC envelope before changing registrations. */
export function validateConfiguration(value: unknown): asserts value is ShortcutConfiguration {
    if (!value || typeof value !== "object") throw new Error("Invalid shortcut configuration");
    const config = value as Partial<ShortcutConfiguration>;
    if (typeof config.enabled !== "boolean" || !Array.isArray(config.bindings) || config.bindings.length > 6) {
        throw new Error("Invalid shortcut configuration");
    }
    const ids = new Set<string>();
    for (const binding of config.bindings) {
        if (
            !binding ||
            typeof binding !== "object" ||
            !ACTION_IDS.includes(binding.id) ||
            ids.has(binding.id) ||
            typeof binding.key !== "string" ||
            binding.key.length > 80 ||
            !["hold", "toggle"].includes(binding.kind) ||
            (binding.id === "push_to_talk" || binding.id === "push_to_mute") !== (binding.kind === "hold")
        ) {
            throw new Error("Invalid shortcut binding");
        }
        ids.add(binding.id);
    }
}

/** Own registrations and guarantee releases across asynchronous backend and renderer lifecycles. */
export class GlobalShortcutController {
    private generation = 0;
    private backend?: ShortcutBackend;
    private bindings: ShortcutBinding[] = [];
    private readonly active = new Set<ActionId>();

    public constructor(
        private readonly factory: BackendFactory,
        private readonly send: (event: ShortcutEvent) => void,
        private readonly showHide: () => void,
    ) {}

    public configure = async (value: unknown): Promise<ShortcutResult> => {
        validateConfiguration(value);
        this.reset();
        const generation = this.generation;
        const result: ShortcutResult = { backend: "unsupported", bindings: [] };
        const keys = new Set<string>();
        const candidates: ShortcutBinding[] = [];
        for (const binding of value.bindings.filter((binding) => binding.key !== "")) {
            const parsed = parseKey(binding.key);
            if (!parsed) result.bindings.push({ id: binding.id, status: "invalid" });
            else if (keys.has(parsed.canonical)) result.bindings.push({ id: binding.id, status: "conflict" });
            else {
                keys.add(parsed.canonical);
                candidates.push(binding);
            }
        }
        if (!value.enabled || !candidates.length) return result;
        let backend: ShortcutBackend | undefined;
        try {
            backend = await this.factory(
                (id, pressed) => {
                    if (generation === this.generation) this.onEvent(id, pressed);
                },
                () => {
                    if (generation === this.generation) this.reset();
                },
            );
            if (generation !== this.generation) {
                backend?.dispose();
                return result;
            }
            this.backend = backend;
            if (!backend) {
                result.bindings.push(...candidates.map(({ id }) => ({ id, status: "unsupported" as const })));
                return result;
            }
            this.bindings = candidates;
            const statuses = await backend.configure(candidates);
            if (generation !== this.generation) return result;
            this.bindings = candidates.filter(({ id }) =>
                statuses.some((status) => status.id === id && status.status === "registered"),
            );
            result.backend = backend.name;
            result.bindings.push(...statuses);
        } catch {
            if (generation === this.generation) this.reset();
            result.backend = "unsupported";
            result.bindings.push(...candidates.map(({ id }) => ({ id, status: "unsupported" as const })));
        }
        return result;
    };

    /** Cancel holds and release-delay timers before unregistering or discarding their renderer. */
    public reset = (): void => {
        this.generation++;
        // A released PTT key can still have a renderer release-delay timer pending.
        for (const id of ["push_to_talk", "push_to_mute"] as const) {
            this.send({ id, pressed: false, reset: true });
        }
        for (const id of this.active) {
            if (this.bindings.find((binding) => binding.id === id)?.kind === "toggle") {
                this.send({ id, pressed: false, reset: true });
            }
        }
        this.active.clear();
        this.bindings = [];
        const backend = this.backend;
        this.backend = undefined;
        backend?.dispose();
    };

    private onEvent(id: ActionId, pressed: boolean): void {
        const binding = this.bindings.find((binding) => binding.id === id);
        if (!binding || this.active.has(id) === pressed) return;
        if (pressed) this.active.add(id);
        else this.active.delete(id);
        if (id === "show_hide" && pressed) this.showHide();
        this.send({ id, pressed });
    }
}
