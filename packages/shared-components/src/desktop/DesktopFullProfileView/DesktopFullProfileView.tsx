/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Avatar, Button, IconButton, Menu, MenuItem, Text } from "@vector-im/compound-web";
import ChatIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import EditIcon from "@vector-im/compound-design-tokens/assets/web/icons/edit";
import LinkIcon from "@vector-im/compound-design-tokens/assets/web/icons/link";
import OverflowHorizontalIcon from "@vector-im/compound-design-tokens/assets/web/icons/overflow-horizontal";
import CheckCircleIcon from "@vector-im/compound-design-tokens/assets/web/icons/check-circle";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import {
    DesktopProfileBanner,
    DesktopProfileBio,
    DesktopProfileNames,
    DesktopProfileRoles,
    DesktopProfileSurface,
    type DesktopProfileIdentitySnapshot,
} from "../DesktopProfileIdentity";
import { type DesktopProfileAvailability, type DesktopProfilePopoutViewActions } from "../DesktopProfilePopoutView";
import styles from "./DesktopFullProfileView.module.css";

/** A room or Space both people are in. */
export interface DesktopProfileMutualItem {
    id: string;
    name: string;
    avatarUrl?: string;
}

/** Mutual rooms come from the server (MSC2666), so they can be unavailable, loading or failed. */
export interface DesktopProfileMutualRooms {
    state: "unsupported" | "loading" | "error" | "ready";
    items: DesktopProfileMutualItem[];
}

/** One tile on the person's board: a game, a project, anything with a picture. */
export interface DesktopProfileBoardItem {
    id: string;
    title: string;
    caption?: string;
    imageUrl?: string;
}

/** The showcase a person fills in by hand. */
export interface DesktopProfileBoard {
    title: string;
    items: DesktopProfileBoardItem[];
}

/** Everything the full profile renders. */
export interface DesktopFullProfileViewSnapshot extends DesktopProfileIdentitySnapshot, DesktopProfileAvailability {
    /** When the person's current stay in the room began, if it is in the history this client has loaded. */
    memberSince?: { text: string; datetime: string };
    /** Cross-signing verification; omitted when encryption is not available. */
    verification?: { verified: boolean; deviceCount: number };
    mutualRooms: DesktopProfileMutualRooms;
    /** Spaces both people are joined to, from members this client already knows. */
    mutualSpaces: DesktopProfileMutualItem[];
    board?: DesktopProfileBoard;
    /** The viewer's private note about this person. Undefined where notes are not available, such as for guests. */
    note?: string;
}

/** Actions the full profile can invoke; each maps to an existing Element action. */
export interface DesktopFullProfileViewActions extends Omit<DesktopProfilePopoutViewActions, "openFullProfile"> {
    openRoom(this: void, id: string): void;
    retryMutualRooms(this: void): void;
    /** Save the viewer's private note. */
    setNote(this: void, note: string): void;
}

/** Contract for the full profile. */
export type DesktopFullProfileViewModel = ViewModel<DesktopFullProfileViewSnapshot, DesktopFullProfileViewActions>;

/** Properties for the full profile. */
interface DesktopFullProfileViewProps {
    vm: DesktopFullProfileViewModel;
}

type TabId = "board" | "rooms" | "spaces";

const NOTE_MAX_LENGTH = 256;

/** A note field that looks like plain text until it is used, and saves when focus leaves it. */
function NoteField({ note, onSave }: { note: string; onSave: (note: string) => void }): JSX.Element {
    const { translate: _t } = useI18n();
    const [value, setValue] = useState(note);
    const id = useId();
    useEffect(() => setValue(note), [note]);
    return (
        <div className={styles.fact}>
            <label className={styles.factLabel} htmlFor={id}>
                {_t("desktop|profile|note_label")}
            </label>
            <textarea
                id={id}
                className={styles.note}
                value={value}
                rows={2}
                maxLength={NOTE_MAX_LENGTH}
                placeholder={_t("desktop|profile|note_placeholder")}
                onChange={(event) => setValue(event.target.value)}
                onBlur={() => {
                    if (value !== note) onSave(value);
                }}
            />
        </div>
    );
}

/** Discord-style large profile: identity and real Matrix facts on the left, what is shared on the right. */
export function DesktopFullProfileView({ vm }: DesktopFullProfileViewProps): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const [menuOpen, setMenuOpen] = useState(false);
    const [selected, setSelected] = useState<TabId>();
    const base = useId();
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const { displayName, mutualRooms, mutualSpaces, board } = snapshot;

    const tabs: { id: TabId; label: string }[] = [];
    if (board?.items.length) tabs.push({ id: "board", label: board.title || _t("desktop|profile|board") });
    if (!snapshot.isMe) {
        if (mutualRooms.state !== "unsupported") {
            tabs.push({
                id: "rooms",
                label:
                    mutualRooms.state === "ready"
                        ? _t("desktop|profile|mutual_rooms_count", { count: mutualRooms.items.length })
                        : _t("desktop|profile|mutual_rooms"),
            });
        }
        tabs.push({ id: "spaces", label: _t("desktop|profile|mutual_spaces_count", { count: mutualSpaces.length }) });
    }
    const active = tabs.find((tab) => tab.id === selected) ?? tabs[0];

    const onTabKeyDown = (event: KeyboardEvent): void => {
        const index = tabs.findIndex((tab) => tab.id === active?.id);
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const next =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index + step + tabs.length) % tabs.length;
        setSelected(tabs[next].id);
        tabRefs.current[tabs[next].id]?.focus();
    };

    const renderItems = (items: DesktopProfileMutualItem[], empty: string): JSX.Element =>
        items.length ? (
            <ul className={styles.list}>
                {items.map((item) => (
                    <li key={item.id}>
                        <button type="button" className={styles.item} onClick={() => vm.openRoom(item.id)}>
                            <Avatar id={item.id} name={item.name} src={item.avatarUrl} size="32px" type="round" />
                            <Text as="span" weight="medium">
                                {item.name}
                            </Text>
                        </button>
                    </li>
                ))}
            </ul>
        ) : (
            <Text as="p" className={styles.empty}>
                {empty}
            </Text>
        );

    return (
        <DesktopProfileSurface identity={snapshot} className={styles.view} backdrop>
            <IconButton
                className={styles.close}
                size="28px"
                tooltip={_t("action|close")}
                aria-label={_t("action|close")}
                onClick={vm.close}
            >
                <CloseIcon />
            </IconButton>
            <section className={styles.profile} aria-label={_t("desktop|profile|section", { name: displayName })}>
                <DesktopProfileBanner identity={snapshot} size="full" />
                <div className={styles.details}>
                    <DesktopProfileNames identity={snapshot} large />
                    <div className={styles.buttons}>
                        {snapshot.isMe && (
                            <Button size="md" Icon={EditIcon} onClick={vm.editProfile}>
                                {_t("desktop|profile|edit_profile")}
                            </Button>
                        )}
                        {snapshot.canMessage && (
                            <Button size="md" Icon={ChatIcon} onClick={() => vm.message("")}>
                                {_t("desktop|profile|message_button")}
                            </Button>
                        )}
                        {snapshot.canVerify && (
                            <Button size="md" kind="secondary" Icon={CheckCircleIcon} onClick={vm.verify}>
                                {_t("desktop|profile|verify")}
                            </Button>
                        )}
                        <Menu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            title={_t("desktop|profile|more")}
                            showTitle={false}
                            trigger={
                                <IconButton size="32px" tooltip={_t("desktop|profile|more")}>
                                    <OverflowHorizontalIcon />
                                </IconButton>
                            }
                        >
                            {snapshot.canMention && (
                                <MenuItem label={_t("desktop|profile|mention")} onSelect={vm.mention} />
                            )}
                            <MenuItem label={_t("desktop|profile|copy_link")} onSelect={vm.copyLink} />
                            {!snapshot.isMe && (
                                <MenuItem
                                    kind={snapshot.isIgnored ? undefined : "critical"}
                                    label={
                                        snapshot.isIgnored
                                            ? _t("desktop|profile|unignore")
                                            : _t("desktop|profile|ignore")
                                    }
                                    onSelect={vm.toggleIgnore}
                                />
                            )}
                            {snapshot.canModerate && (
                                <MenuItem label={_t("desktop|profile|moderate")} onSelect={vm.moderate} />
                            )}
                        </Menu>
                    </div>
                    {snapshot.bio && <DesktopProfileBio bio={snapshot.bio} />}
                    <dl className={styles.facts}>
                        {snapshot.memberSince && (
                            <div className={styles.fact}>
                                <dt className={styles.factLabel}>{_t("desktop|profile|member_since")}</dt>
                                <dd>
                                    <time dateTime={snapshot.memberSince.datetime}>{snapshot.memberSince.text}</time>
                                </dd>
                            </div>
                        )}
                        {snapshot.localTime && (
                            <div className={styles.fact}>
                                <dt className={styles.factLabel}>{_t("desktop|profile|local_time")}</dt>
                                <dd>{snapshot.localTime}</dd>
                            </div>
                        )}
                        {snapshot.verification && (
                            <div className={styles.fact}>
                                <dt className={styles.factLabel}>{_t("desktop|profile|verification")}</dt>
                                <dd>
                                    {snapshot.verification.verified
                                        ? _t("desktop|profile|verified")
                                        : _t("desktop|profile|not_verified")}
                                    {" · "}
                                    {_t("desktop|profile|sessions", { count: snapshot.verification.deviceCount })}
                                </dd>
                            </div>
                        )}
                    </dl>
                    {snapshot.roles.length > 0 && (
                        <div className={styles.fact}>
                            <span className={styles.factLabel}>{_t("desktop|profile|roles")}</span>
                            <DesktopProfileRoles roles={snapshot.roles} />
                        </div>
                    )}
                    {!!snapshot.links?.length && (
                        <div className={styles.fact}>
                            <span className={styles.factLabel}>{_t("desktop|profile|links")}</span>
                            <ul className={styles.links}>
                                {snapshot.links.map((link) => (
                                    <li key={link.url}>
                                        <a
                                            className={styles.link}
                                            href={link.url}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                        >
                                            <LinkIcon aria-hidden="true" width="16px" height="16px" />
                                            <span>{link.label}</span>
                                            <span className={styles.linkHost}>{link.host}</span>
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {snapshot.note !== undefined && !snapshot.isMe && (
                        <NoteField note={snapshot.note} onSave={vm.setNote} />
                    )}
                </div>
            </section>
            <section className={styles.shared}>
                {active ? (
                    <>
                        <div role="tablist" aria-label={_t("desktop|profile|shared_context")} className={styles.tabs}>
                            {tabs.map((tab) => (
                                <button
                                    key={tab.id}
                                    ref={(element) => {
                                        tabRefs.current[tab.id] = element;
                                    }}
                                    type="button"
                                    role="tab"
                                    id={`${base}-${tab.id}-tab`}
                                    aria-selected={tab.id === active.id}
                                    aria-controls={`${base}-panel`}
                                    tabIndex={tab.id === active.id ? 0 : -1}
                                    className={styles.tab}
                                    onKeyDown={onTabKeyDown}
                                    onClick={() => setSelected(tab.id)}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                        <div
                            key={active.id}
                            role="tabpanel"
                            id={`${base}-panel`}
                            aria-labelledby={`${base}-${active.id}-tab`}
                            className={styles.panel}
                        >
                            {active.id === "board" ? (
                                <ul className={styles.board}>
                                    {board?.items.map((item) => (
                                        <li key={item.id} className={styles.boardItem}>
                                            {item.imageUrl ? (
                                                <img src={item.imageUrl} alt="" loading="lazy" />
                                            ) : (
                                                <div className={styles.boardPlaceholder} aria-hidden="true" />
                                            )}
                                            <Text as="span" size="sm" weight="semibold">
                                                {item.title}
                                            </Text>
                                            {item.caption && (
                                                <Text as="span" size="xs" className={styles.boardCaption}>
                                                    {item.caption}
                                                </Text>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            ) : active.id === "rooms" ? (
                                mutualRooms.state === "loading" ? (
                                    <Text as="p" role="status" className={styles.empty}>
                                        {_t("desktop|profile|mutual_loading")}
                                    </Text>
                                ) : mutualRooms.state === "error" ? (
                                    <div role="alert" className={styles.empty}>
                                        <Text as="p">{_t("desktop|profile|mutual_error")}</Text>
                                        <Button size="md" kind="secondary" onClick={vm.retryMutualRooms}>
                                            {_t("action|retry")}
                                        </Button>
                                    </div>
                                ) : (
                                    renderItems(mutualRooms.items, _t("desktop|profile|mutual_rooms_empty"))
                                )
                            ) : (
                                <>
                                    {renderItems(mutualSpaces, _t("desktop|profile|mutual_spaces_empty"))}
                                    <Text as="p" size="md" className={styles.caption}>
                                        {_t("desktop|profile|mutual_spaces_note")}
                                    </Text>
                                </>
                            )}
                        </div>
                    </>
                ) : (
                    <Text as="p" className={styles.empty}>
                        {_t("desktop|profile|self_note")}
                    </Text>
                )}
            </section>
        </DesktopProfileSurface>
    );
}
