/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Actions accepted from the desktop shell renderer. */
export const ACTION_IDS = [
    "push_to_talk",
    "push_to_mute",
    "toggle_mute",
    "toggle_deafen",
    "toggle_input_mode",
    "show_hide",
] as const;
/** Allowlisted action identifier; no raw key data crosses IPC. */
export type ActionId = (typeof ACTION_IDS)[number];
/** Renderer configuration; keys use KeyboardEvent.code names. */
export interface ShortcutBinding {
    id: ActionId;
    key: string;
    kind: "hold" | "toggle";
}
/** Complete replace operation for the current desktop registrations. */
export interface ShortcutConfiguration {
    enabled: boolean;
    bindings: ShortcutBinding[];
}
/** Activation edge, or a forced hold release after a lifecycle reset. */
export interface ShortcutEvent {
    id: ActionId;
    pressed: boolean;
    reset?: boolean;
}
/** Result of registering one configured action. */
export type BindingStatus = "registered" | "conflict" | "unsupported" | "invalid";
/** Backend availability and individual binding outcomes. */
export interface ShortcutResult {
    backend: "native" | "portal" | "unsupported";
    bindings: { id: ActionId; status: BindingStatus }[];
}
/** Backend events contain only configured action identifiers. */
export interface ShortcutBackend {
    name: "native" | "portal";
    configure: (bindings: ShortcutBinding[]) => Promise<ShortcutResult["bindings"]>;
    dispose: () => void;
}
/** Construct a backend with bounded action events and a fatal-error callback. */
export type BackendFactory = (
    emit: (id: ActionId, pressed: boolean) => void,
    failed: () => void,
) => Promise<ShortcutBackend | undefined>;
