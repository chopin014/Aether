/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, {
    type JSX,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronRightIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { UserVolumeSlider } from "./UserVolumeSlider";
import styles from "./VoiceUserMenuView.module.css";

/** A role the person can be given in the channel, as a Matrix power level. */
export interface VoiceUserMenuRole {
    /** The power level the role stands for. */
    readonly level: number;
    /** The role's name, such as "Moderator". */
    readonly label: string;
    /** Whether the person currently has this role. */
    readonly selected: boolean;
}

/** A server (a Matrix Space) the person can be invited to. */
export interface VoiceUserMenuServer {
    readonly id: string;
    readonly name: string;
}

/** Everything the voice user menu shows about one person. */
export interface VoiceUserMenuViewSnapshot {
    readonly userId: string;
    readonly displayName: string;
    /** Whether the menu is for the user's own account; it then offers their microphone and deafen instead. */
    readonly isSelf: boolean;
    /** Whether a mention of the person can be put into the open composer. */
    readonly canMention: boolean;
    /** Whether a direct conversation with the person can be opened. */
    readonly canMessage: boolean;
    /** Whether a call with the person can be started, from an existing direct conversation. */
    readonly canCall: boolean;
    /** How loud the person is played, from 0 to 200. */
    readonly volumePercent: number;
    /** Whether the person is muted for this user only. */
    readonly muted: boolean;
    /** Whether the person's soundboard sounds are muted for this user only. */
    readonly soundboardMuted: boolean;
    /** Whether the person's camera is hidden for this user only. */
    readonly videoDisabled: boolean;
    /** The user's own microphone, shown on their own menu. */
    readonly microphoneMuted: boolean;
    /** Whether the user is deafened, shown on their own menu. */
    readonly deafened: boolean;
    /** Whether the person's devices can be verified. */
    readonly canVerify: boolean;
    /** Whether the user ignores the person. */
    readonly isIgnored: boolean;
    /** Servers the person can be invited to; the entry is hidden when there are none. */
    readonly inviteServers: readonly VoiceUserMenuServer[];
    /** Roles the user may give the person in this channel; the entry is hidden when there are none. */
    readonly roles: readonly VoiceUserMenuRole[];
}

/** What choosing an entry in the voice user menu does. */
export interface VoiceUserMenuViewActions {
    viewProfile(): void;
    mention(): void;
    message(): void;
    startCall(): void;
    setVolume(percent: number): void;
    toggleMuted(): void;
    toggleSoundboardMuted(): void;
    toggleVideoDisabled(): void;
    toggleMicrophoneMuted(): void;
    toggleDeafened(): void;
    editProfile(): void;
    verify(): void;
    inviteToServer(serverId: string): void;
    copyUserId(): void;
    toggleIgnore(): void;
    setRole(level: number): void;
}

/** The view model behind the voice user menu. */
export type VoiceUserMenuViewModel = ViewModel<VoiceUserMenuViewSnapshot, VoiceUserMenuViewActions>;

/** Props for {@link VoiceUserMenuView}. */
export interface VoiceUserMenuViewProps {
    /** The person the menu is about. */
    vm: VoiceUserMenuViewModel;
    /** The point, in the window's coordinates, where the menu opens: the pointer, or a corner of its trigger. */
    position: { x: number; y: number };
    /** The document the menu belongs to; a call popped out into its own window passes that window's document. */
    ownerDocument?: Document;
    /** Called when the menu should close. */
    onClose: () => void;
}

const ITEM_SELECTOR = "[role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], input[type='range']";
const GUTTER = 8;
const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** Places a panel at a point, moving it back inside the window instead of letting it overflow. */
function usePlacement(
    panel: React.RefObject<HTMLElement | null>,
    point: { x: number; y: number },
    alternateX?: number,
): { left: number; top: number } | null {
    const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
    useLayoutEffect(() => {
        const element = panel.current;
        if (!element) return;
        const view = element.ownerDocument.defaultView ?? window;
        const { width, height } = element.getBoundingClientRect();
        let left = point.x;
        if (left + width > view.innerWidth - GUTTER) left = (alternateX ?? point.x) - width;
        let top = point.y;
        if (top + height > view.innerHeight - GUTTER) top = view.innerHeight - GUTTER - height;
        setPlacement({
            left: Math.max(GUTTER, Math.min(left, view.innerWidth - GUTTER - width)),
            top: Math.max(GUTTER, top),
        });
    }, [panel, point.x, point.y, alternateX]);
    return placement;
}

/** Moves focus between the entries of a menu with the arrow keys, Home and End. */
function moveFocus(container: HTMLElement, event: ReactKeyboardEvent): boolean {
    const items = [...container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
        (item) => item.closest("[data-voice-user-menu]") === container && !item.hasAttribute("disabled"),
    );
    if (items.length === 0) return false;
    const index = items.indexOf(container.ownerDocument.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
        case "ArrowDown":
            next = index < 0 ? 0 : (index + 1) % items.length;
            break;
        case "ArrowUp":
            next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
            break;
        case "Home":
            next = 0;
            break;
        case "End":
            next = items.length - 1;
            break;
        default:
            return false;
    }
    event.preventDefault();
    items[next].focus();
    return true;
}

interface SubMenuProps {
    label: string;
    testId: string;
    /** Whether this submenu is the open one. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
}

/** An entry that opens a further list beside the menu, on hover, click or the right arrow. */
function SubMenu({ label, testId, open, onOpenChange, children }: SubMenuProps): JSX.Element {
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const closeTimer = useRef<number | undefined>(undefined);
    const [anchor, setAnchor] = useState<{ x: number; y: number; alternateX: number } | null>(null);
    const placement = usePlacement(panel, anchor ?? { x: 0, y: 0 }, anchor?.alternateX);
    const id = useId();

    const show = (focusFirst = false): void => {
        window.clearTimeout(closeTimer.current);
        const button = trigger.current;
        if (!button) return;
        const menu = button.closest<HTMLElement>("[data-voice-user-menu]")!.getBoundingClientRect();
        const item = button.getBoundingClientRect();
        setAnchor({ x: menu.right + 4, y: item.top - 6, alternateX: menu.left - 4 });
        onOpenChange(true);
        if (focusFirst) {
            requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus());
        }
    };
    const hideSoon = (): void => {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => onOpenChange(false), 200);
    };
    useEffect(() => () => window.clearTimeout(closeTimer.current), []);

    return (
        <>
            <button
                ref={trigger}
                type="button"
                role="menuitem"
                className={styles.item}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                data-open={open || undefined}
                data-testid={testId}
                onPointerEnter={() => show()}
                onPointerLeave={hideSoon}
                onClick={() => show(true)}
                onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        show(true);
                    }
                }}
            >
                <span className={styles.label}>{label}</span>
                <ChevronRightIcon className={styles.chevron} aria-hidden="true" />
            </button>
            {open && anchor && (
                <div
                    ref={panel}
                    id={id}
                    role="menu"
                    tabIndex={-1}
                    aria-label={label}
                    className={styles.menu}
                    data-voice-user-menu=""
                    data-submenu=""
                    style={{
                        position: "fixed",
                        left: placement?.left ?? anchor.x,
                        top: placement?.top ?? anchor.y,
                        visibility: placement ? undefined : "hidden",
                    }}
                    onPointerEnter={() => window.clearTimeout(closeTimer.current)}
                    onPointerLeave={hideSoon}
                    onKeyDown={(event) => {
                        if (event.key === "ArrowLeft" || event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            onOpenChange(false);
                            trigger.current?.focus();
                            return;
                        }
                        if (moveFocus(panel.current!, event)) event.stopPropagation();
                    }}
                >
                    {children}
                </div>
            )}
        </>
    );
}

interface ItemProps {
    label: string;
    onSelect: () => void;
    /** Called when the pointer reaches the entry, so an open submenu can close. */
    onHover: () => void;
    critical?: boolean;
    testId?: string;
}

/** An entry that runs an action. */
function Item({ label, onSelect, onHover, critical, testId }: ItemProps): JSX.Element {
    return (
        <button
            type="button"
            role="menuitem"
            className={styles.item}
            data-kind={critical ? "critical" : undefined}
            data-testid={testId}
            onPointerEnter={onHover}
            onClick={onSelect}
        >
            <span className={styles.label}>{label}</span>
        </button>
    );
}

interface CheckboxItemProps {
    label: string;
    checked: boolean;
    onToggle: () => void;
    onHover: () => void;
    testId?: string;
}

/** An entry that turns something on or off, with Discord's checkbox at its end. It keeps the menu open. */
function CheckboxItem({ label, checked, onToggle, onHover, testId }: CheckboxItemProps): JSX.Element {
    return (
        <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={checked}
            className={styles.item}
            data-testid={testId}
            onPointerEnter={onHover}
            onClick={onToggle}
        >
            <span className={styles.label}>{label}</span>
            <span className={styles.checkbox} aria-hidden="true">
                {checked && <CheckIcon />}
            </span>
        </button>
    );
}

const Separator = (): JSX.Element => <hr className={styles.separator} />;

/**
 * A Discord-style menu for a person in a voice channel or call: their profile, a direct conversation, how loud
 * they are played and whether they are muted for this user only, and the Matrix actions that apply to them.
 * It renders into its own document, so it also works in fullscreen and in a call popped out into its own window.
 */
export function VoiceUserMenuView({ vm, position, ownerDocument, onClose }: VoiceUserMenuViewProps): JSX.Element {
    const s = useViewModel(vm);
    const menu = useRef<HTMLDivElement>(null);
    const placement = usePlacement(menu, position);
    const [openSubMenu, setOpenSubMenu] = useState<"invite" | "roles" | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const doc = ownerDocument ?? document;
    // Escape returns focus to whatever had it when the menu opened, normally the person that was right-clicked.
    const returnFocus = useRef(doc.activeElement);

    // Focus the menu once it is placed, so the arrow keys reach it straight away.
    useEffect(() => {
        if (placement) menu.current?.focus({ preventScroll: true });
    }, [placement]);

    // Close on a click or right click elsewhere, and when the window loses focus or changes size.
    useEffect(() => {
        const view = doc.defaultView ?? window;
        const onPointerDown = (event: PointerEvent): void => {
            // A popped out call has its own window, whose nodes are not instances of this window's Element.
            const target = event.target as Node | null;
            const element = target?.nodeType === Node.ELEMENT_NODE ? (target as Element) : target?.parentElement;
            // A button that toggles the menu closes it itself when clicked.
            if (element?.closest("[data-voice-user-menu], [data-voice-user-menu-toggle]")) return;
            closeRef.current();
        };
        const close = (): void => closeRef.current();
        doc.addEventListener("pointerdown", onPointerDown, true);
        view.addEventListener("blur", close);
        view.addEventListener("resize", close);
        return () => {
            doc.removeEventListener("pointerdown", onPointerDown, true);
            view.removeEventListener("blur", close);
            view.removeEventListener("resize", close);
        };
    }, [doc]);

    /** Runs an entry that leaves the menu, closing it first so whatever the entry opens takes focus. */
    const select = (action: () => void) => (): void => {
        closeRef.current();
        action();
    };

    const closeSubMenu = (): void => setOpenSubMenu(null);

    const content = (
        <div
            ref={menu}
            role="menu"
            tabIndex={-1}
            aria-label={_t("desktop|voice_user_menu|title", { name: s.displayName })}
            className={styles.menu}
            data-voice-user-menu=""
            data-testid="voice-user-menu"
            style={{
                position: "fixed",
                left: placement?.left ?? position.x,
                top: placement?.top ?? position.y,
                visibility: placement ? undefined : "hidden",
            }}
            // The menu's own keys must not also move the room list's selection or reach the call's shortcuts.
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape" || event.key === "Tab") {
                    event.preventDefault();
                    onClose();
                    const previous = returnFocus.current as HTMLElement | null;
                    if (previous?.isConnected && previous !== previous.ownerDocument.body) {
                        previous.focus({ preventScroll: true });
                    }
                    return;
                }
                // On the volume slider, the keys that change its value keep doing so; up and down still move on.
                const onSlider = (event.target as HTMLElement).matches("input[type='range']");
                if (onSlider && SLIDER_KEYS.has(event.key)) return;
                moveFocus(menu.current!, event);
            }}
            onContextMenu={(event) => event.preventDefault()}
        >
            <Item
                onHover={closeSubMenu}
                label={_t("desktop|voice_user_menu|profile")}
                onSelect={select(vm.viewProfile)}
            />
            {s.canMention && (
                <Item
                    onHover={closeSubMenu}
                    label={_t("desktop|voice_user_menu|mention")}
                    onSelect={select(vm.mention)}
                />
            )}
            {!s.isSelf && s.canMessage && (
                <Item
                    onHover={closeSubMenu}
                    label={_t("desktop|voice_user_menu|message")}
                    onSelect={select(vm.message)}
                />
            )}
            {!s.isSelf && s.canCall && (
                <Item
                    onHover={closeSubMenu}
                    label={_t("desktop|voice_user_menu|start_call")}
                    onSelect={select(vm.startCall)}
                />
            )}
            <Separator />
            {s.isSelf ? (
                <>
                    <CheckboxItem
                        onHover={closeSubMenu}
                        label={_t("desktop|voice_user_menu|mute_microphone")}
                        checked={s.microphoneMuted}
                        onToggle={vm.toggleMicrophoneMuted}
                        testId="voice-user-menu-self-mute"
                    />
                    <CheckboxItem
                        onHover={closeSubMenu}
                        label={_t("desktop|voice_user_menu|deafen")}
                        checked={s.deafened}
                        onToggle={vm.toggleDeafened}
                        testId="voice-user-menu-self-deafen"
                    />
                    <Separator />
                    <Item
                        onHover={closeSubMenu}
                        label={_t("desktop|voice_user_menu|edit_profile")}
                        onSelect={select(vm.editProfile)}
                    />
                </>
            ) : (
                <>
                    <div className={styles.volume} onPointerEnter={closeSubMenu}>
                        <span className={styles.volumeTitle}>{_t("desktop|voice_user_menu|user_volume")}</span>
                        <UserVolumeSlider
                            label={_t("desktop|voice_user_menu|user_volume_for", { name: s.displayName })}
                            value={s.muted ? 0 : s.volumePercent}
                            onChange={vm.setVolume}
                            testId="voice-user-menu-volume"
                        />
                    </div>
                    <Separator />
                    <CheckboxItem
                        onHover={closeSubMenu}
                        label={_t("desktop|voice_user_menu|mute")}
                        checked={s.muted}
                        onToggle={vm.toggleMuted}
                        testId="voice-user-menu-mute"
                    />
                    <CheckboxItem
                        onHover={closeSubMenu}
                        label={_t("desktop|voice_user_menu|mute_soundboard")}
                        checked={s.soundboardMuted}
                        onToggle={vm.toggleSoundboardMuted}
                        testId="voice-user-menu-mute-soundboard"
                    />
                    <CheckboxItem
                        onHover={closeSubMenu}
                        label={_t("desktop|voice_user_menu|disable_video")}
                        checked={s.videoDisabled}
                        onToggle={vm.toggleVideoDisabled}
                        testId="voice-user-menu-disable-video"
                    />
                    <Separator />
                    {s.canVerify && (
                        <Item
                            onHover={closeSubMenu}
                            label={_t("desktop|voice_user_menu|verify")}
                            onSelect={select(vm.verify)}
                        />
                    )}
                    {s.inviteServers.length > 0 && (
                        <SubMenu
                            label={_t("desktop|voice_user_menu|invite_to_server")}
                            testId="voice-user-menu-invite"
                            open={openSubMenu === "invite"}
                            onOpenChange={(open) => setOpenSubMenu(open ? "invite" : null)}
                        >
                            {s.inviteServers.map((server) => (
                                <button
                                    key={server.id}
                                    type="button"
                                    role="menuitem"
                                    className={styles.item}
                                    onClick={select(() => vm.inviteToServer(server.id))}
                                >
                                    <span className={styles.label}>{server.name}</span>
                                </button>
                            ))}
                        </SubMenu>
                    )}
                </>
            )}
            <Item
                onHover={closeSubMenu}
                label={_t("desktop|voice_user_menu|copy_user_id")}
                onSelect={select(vm.copyUserId)}
            />
            {!s.isSelf && (
                <Item
                    onHover={closeSubMenu}
                    label={s.isIgnored ? _t("desktop|voice_user_menu|unignore") : _t("desktop|voice_user_menu|ignore")}
                    critical={!s.isIgnored}
                    onSelect={select(vm.toggleIgnore)}
                    testId="voice-user-menu-ignore"
                />
            )}
            {s.roles.length > 0 && (
                <>
                    <Separator />
                    <SubMenu
                        label={_t("desktop|voice_user_menu|roles")}
                        testId="voice-user-menu-roles"
                        open={openSubMenu === "roles"}
                        onOpenChange={(open) => setOpenSubMenu(open ? "roles" : null)}
                    >
                        {s.roles.map((role) => (
                            <button
                                key={role.level}
                                type="button"
                                role="menuitemradio"
                                aria-checked={role.selected}
                                className={styles.item}
                                onClick={select(() => vm.setRole(role.level))}
                            >
                                <span className={styles.label}>{role.label}</span>
                                <span className={styles.checkbox} aria-hidden="true">
                                    {role.selected && <CheckIcon />}
                                </span>
                            </button>
                        ))}
                    </SubMenu>
                </>
            )}
        </div>
    );

    const root = doc.fullscreenElement ?? doc.body;
    return createPortal(content, root);
}
