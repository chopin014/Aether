/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type KeyboardEvent, useId, useRef, useState } from "react";
import { Avatar, Button, IconButton, Menu, MenuItem, Text } from "@vector-im/compound-web";
import ChatIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import OverflowHorizontalIcon from "@vector-im/compound-design-tokens/assets/web/icons/overflow-horizontal";
import CheckCircleIcon from "@vector-im/compound-design-tokens/assets/web/icons/check-circle";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import {
    DesktopProfileBanner,
    DesktopProfileNames,
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

/** Everything the full profile renders. */
export interface DesktopFullProfileViewSnapshot extends DesktopProfileIdentitySnapshot, DesktopProfileAvailability {
    /** When the person's current stay in the room began, if it is in the history this client has loaded. */
    memberSince?: { text: string; datetime: string };
    /** Cross-signing verification; omitted when encryption is not available. */
    verification?: { verified: boolean; deviceCount: number };
    mutualRooms: DesktopProfileMutualRooms;
    /** Spaces both people are joined to, from members this client already knows. */
    mutualSpaces: DesktopProfileMutualItem[];
}

/** Actions the full profile can invoke; each maps to an existing Element action. */
export interface DesktopFullProfileViewActions extends Omit<DesktopProfilePopoutViewActions, "openFullProfile"> {
    openRoom(this: void, id: string): void;
    retryMutualRooms(this: void): void;
}

/** Contract for the full profile. */
export type DesktopFullProfileViewModel = ViewModel<DesktopFullProfileViewSnapshot, DesktopFullProfileViewActions>;

/** Properties for the full profile. */
interface DesktopFullProfileViewProps {
    vm: DesktopFullProfileViewModel;
}

type TabId = "rooms" | "spaces";

/** Discord-style large profile: identity and real Matrix facts on the left, shared context on the right. */
export function DesktopFullProfileView({ vm }: DesktopFullProfileViewProps): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const [menuOpen, setMenuOpen] = useState(false);
    const [selected, setSelected] = useState<TabId>(snapshot.mutualRooms.state === "unsupported" ? "spaces" : "rooms");
    const base = useId();
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const { displayName, mutualRooms, mutualSpaces } = snapshot;

    const tabs: { id: TabId; label: string }[] = [];
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

    const renderItems = (items: DesktopProfileMutualItem[], empty: string, openable: boolean): JSX.Element =>
        items.length ? (
            <ul className={styles.list}>
                {items.map((item) => (
                    <li key={item.id}>
                        {openable ? (
                            <button type="button" className={styles.item} onClick={() => vm.openRoom(item.id)}>
                                <Avatar id={item.id} name={item.name} src={item.avatarUrl} size="32px" type="round" />
                                <Text as="span" weight="medium">
                                    {item.name}
                                </Text>
                            </button>
                        ) : (
                            <span className={styles.item}>
                                <Avatar id={item.id} name={item.name} src={item.avatarUrl} size="32px" type="round" />
                                <Text as="span" weight="medium">
                                    {item.name}
                                </Text>
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        ) : (
            <Text as="p" className={styles.empty}>
                {empty}
            </Text>
        );

    return (
        <div className={styles.view}>
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
                    <DesktopProfileNames identity={snapshot} />
                    <div className={styles.buttons}>
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
                    <dl className={styles.facts}>
                        {snapshot.memberSince && (
                            <div>
                                <dt>{_t("desktop|profile|member_since")}</dt>
                                <dd>
                                    <time dateTime={snapshot.memberSince.datetime}>{snapshot.memberSince.text}</time>
                                </dd>
                            </div>
                        )}
                        {snapshot.verification && (
                            <div>
                                <dt>{_t("desktop|profile|verification")}</dt>
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
                            role="tabpanel"
                            id={`${base}-panel`}
                            aria-labelledby={`${base}-${active.id}-tab`}
                            className={styles.panel}
                        >
                            {active.id === "rooms" ? (
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
                                    renderItems(mutualRooms.items, _t("desktop|profile|mutual_rooms_empty"), true)
                                )
                            ) : (
                                <>
                                    {renderItems(mutualSpaces, _t("desktop|profile|mutual_spaces_empty"), true)}
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
        </div>
    );
}
