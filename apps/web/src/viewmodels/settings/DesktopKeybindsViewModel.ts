/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopKeybindsSnapshot,
    type DesktopKeybindsViewModel as ViewModel,
} from "@element-hq/web-shared-components";

import {
    DesktopShortcutManager,
    DESKTOP_SHORTCUT_ACTIONS,
    type DesktopShortcutAction,
} from "../../audio/desktop/DesktopShortcutManager";
import {
    describePushToTalkKey,
    formatPushToTalkKey,
    pushToTalkBindingFromEvent,
    isModifierCode,
    pushToTalkBindingFromModifier,
} from "../../audio/desktop/PushToTalk";
import { _t, _td } from "../../languageHandler";

const labels = {
    push_to_talk: _td("desktop|keybinds|push_to_talk"),
    push_to_mute: _td("desktop|keybinds|push_to_mute"),
    toggle_mute: _td("desktop|keybinds|toggle_mute"),
    toggle_deafen: _td("desktop|keybinds|toggle_deafen"),
    toggle_input_mode: _td("desktop|keybinds|toggle_input_mode"),
    show_hide: _td("desktop|keybinds|show_hide"),
};
const statusLabels = {
    registered: _td("desktop|keybinds|registered"),
    conflict: _td("desktop|keybinds|conflict"),
    unsupported: _td("desktop|keybinds|unsupported"),
    invalid: _td("desktop|keybinds|invalid"),
    unbound: _td("desktop|keybinds|unbound"),
    focused: _td("desktop|keybinds|focused"),
    paused: _td("desktop|keybinds|paused"),
};

/** Settings model; registrations belong to the logged-in voice controls, not this modal. */
export class DesktopKeybindsViewModel extends BaseViewModel<DesktopKeybindsSnapshot, undefined> implements ViewModel {
    private cancelRecording?: () => void;
    public constructor(
        private readonly manager = DesktopShortcutManager.instance,
        private readonly target = window,
    ) {
        super(undefined, { rows: [], description: "" });
        this.disposables.track(manager.subscribe(this.refresh));
        this.disposables.track(() => this.cancelRecording?.());
        this.refresh();
    }
    private readonly refresh = (): void => {
        this.snapshot.merge({
            rows: DESKTOP_SHORTCUT_ACTIONS.map((id) => ({
                id,
                label: _t(labels[id]),
                key: describePushToTalkKey(this.manager.getKey(id)),
                status: _t(statusLabels[this.manager.getStatus(id)]),
            })),
            description:
                this.manager.getBackend() === "focused"
                    ? _t("desktop|keybinds|browser_description")
                    : _t("desktop|keybinds|desktop_description"),
        });
    };
    private save(id: DesktopShortcutAction, key: string): void {
        void this.manager.setKey(id, key).catch(() => {
            if (!this.isDisposed) this.snapshot.merge({ error: _t("desktop|keybinds|save_failed") });
        });
    }
    public clear = (id: string): void => {
        if (!DESKTOP_SHORTCUT_ACTIONS.includes(id as DesktopShortcutAction)) return;
        this.cancelRecording?.();
        this.save(id as DesktopShortcutAction, "");
    };
    public record = (id: string): void => {
        if (!DESKTOP_SHORTCUT_ACTIONS.includes(id as DesktopShortcutAction)) return;
        const previous = this.snapshot.current.recording;
        this.cancelRecording?.();
        if (previous === id) return;
        const resume = this.manager.suspend();
        const finish = (key?: string): void => {
            this.target.removeEventListener("keydown", down, true);
            this.target.removeEventListener("keyup", up, true);
            this.target.removeEventListener("blur", blur);
            this.cancelRecording = undefined;
            if (!this.isDisposed) this.snapshot.merge({ recording: undefined });
            if (key) {
                void this.manager
                    .setKey(id as DesktopShortcutAction, key)
                    .catch(() => {
                        if (!this.isDisposed) this.snapshot.merge({ error: _t("desktop|keybinds|save_failed") });
                    })
                    .finally(resume);
            } else resume();
        };
        const swallow = (event: KeyboardEvent): void => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const down = (event: KeyboardEvent): void => {
            swallow(event);
            if (event.code === "Escape") return finish();
            if (event.repeat) return;
            const key = pushToTalkBindingFromEvent(event);
            if (key) finish(formatPushToTalkKey(key));
        };
        const up = (event: KeyboardEvent): void => {
            swallow(event);
            if (isModifierCode(event.code)) finish(formatPushToTalkKey(pushToTalkBindingFromModifier(event.code)));
        };
        const blur = (): void => finish();
        this.target.addEventListener("keydown", down, true);
        this.target.addEventListener("keyup", up, true);
        this.target.addEventListener("blur", blur);
        this.cancelRecording = () => finish();
        this.snapshot.merge({ recording: id, error: undefined });
    };
}
