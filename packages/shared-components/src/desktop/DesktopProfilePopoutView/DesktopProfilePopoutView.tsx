/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type FormEvent, useId, useState } from "react";
import { IconButton, Menu, MenuItem, Text } from "@vector-im/compound-web";
import ChatIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat";
import OverflowHorizontalIcon from "@vector-im/compound-design-tokens/assets/web/icons/overflow-horizontal";
import CheckCircleIcon from "@vector-im/compound-design-tokens/assets/web/icons/check-circle";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import {
    DesktopProfileBanner,
    DesktopProfileNames,
    type DesktopProfileIdentitySnapshot,
} from "../DesktopProfileIdentity";
import styles from "./DesktopProfilePopoutView.module.css";

/** What the profile card can offer for this person, in this room, right now. */
export interface DesktopProfileAvailability {
    isMe: boolean;
    /** A direct conversation can be opened with this user. */
    canMessage: boolean;
    /** Verification can be started with this user. */
    canVerify: boolean;
    isVerified: boolean;
    /** The user can be mentioned in the composer of the room being viewed. */
    canMention: boolean;
    isIgnored: boolean;
    /** The current user may moderate this member, which hands over to the room info panel. */
    canModerate: boolean;
}

/** Everything the popout card renders. */
export interface DesktopProfilePopoutViewSnapshot extends DesktopProfileIdentitySnapshot, DesktopProfileAvailability {
    /** A direct message is being opened. */
    busy: boolean;
    /** The direct message could not be opened. */
    error: boolean;
}

/** Actions the popout card can invoke; each maps to an existing Element action. */
export interface DesktopProfilePopoutViewActions {
    /** Open (or begin) the direct conversation, carrying the draft into its composer. */
    message(this: void, draft: string): void;
    verify(this: void): void;
    mention(this: void): void;
    copyLink(this: void): void;
    toggleIgnore(this: void): void;
    moderate(this: void): void;
    openFullProfile(this: void): void;
    close(this: void): void;
}

/** Contract for the profile popout. */
export type DesktopProfilePopoutViewModel = ViewModel<
    DesktopProfilePopoutViewSnapshot,
    DesktopProfilePopoutViewActions
>;

/** Properties for the profile popout card. */
interface DesktopProfilePopoutViewProps {
    vm: DesktopProfilePopoutViewModel;
}

/** A small Discord-style profile card: banner, identity, roles and a message field. */
export function DesktopProfilePopoutView({ vm }: DesktopProfilePopoutViewProps): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const [draft, setDraft] = useState("");
    const [menuOpen, setMenuOpen] = useState(false);
    const nameId = useId();
    const { displayName, canMessage, busy, error } = snapshot;

    const submit = (event: FormEvent): void => {
        event.preventDefault();
        if (!busy) vm.message(draft);
    };

    return (
        <section className={styles.card} aria-labelledby={nameId}>
            <DesktopProfileBanner
                identity={snapshot}
                size="popout"
                renderAvatar={(avatar) => (
                    <button
                        type="button"
                        className={styles.plainButton}
                        aria-label={_t("desktop|profile|view_full", { name: displayName })}
                        onClick={vm.openFullProfile}
                    >
                        {avatar}
                    </button>
                )}
            >
                {snapshot.canVerify && (
                    <IconButton
                        className={styles.action}
                        size="28px"
                        tooltip={_t("desktop|profile|verify")}
                        onClick={vm.verify}
                    >
                        <CheckCircleIcon />
                    </IconButton>
                )}
                {canMessage && (
                    <IconButton
                        className={styles.action}
                        size="28px"
                        tooltip={_t("desktop|profile|message_button")}
                        onClick={() => vm.message("")}
                    >
                        <ChatIcon />
                    </IconButton>
                )}
                <Menu
                    className={styles.menu}
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    title={_t("desktop|profile|more")}
                    showTitle={false}
                    align="end"
                    trigger={
                        <IconButton className={styles.action} size="28px" tooltip={_t("desktop|profile|more")}>
                            <OverflowHorizontalIcon />
                        </IconButton>
                    }
                >
                    <MenuItem label={_t("desktop|profile|view_full_menu")} onSelect={vm.openFullProfile} />
                    {snapshot.canMention && <MenuItem label={_t("desktop|profile|mention")} onSelect={vm.mention} />}
                    <MenuItem label={_t("desktop|profile|copy_link")} onSelect={vm.copyLink} />
                    {!snapshot.isMe && (
                        <MenuItem
                            kind={snapshot.isIgnored ? undefined : "critical"}
                            label={snapshot.isIgnored ? _t("desktop|profile|unignore") : _t("desktop|profile|ignore")}
                            onSelect={vm.toggleIgnore}
                        />
                    )}
                    {snapshot.canModerate && <MenuItem label={_t("desktop|profile|moderate")} onSelect={vm.moderate} />}
                </Menu>
            </DesktopProfileBanner>
            <div className={styles.body}>
                <DesktopProfileNames
                    identity={snapshot}
                    nameId={nameId}
                    renderName={(name) => (
                        <button type="button" className={styles.nameButton} onClick={vm.openFullProfile}>
                            {name}
                        </button>
                    )}
                />
                {canMessage && (
                    <form className={styles.composer} onSubmit={submit}>
                        <label className={styles.visuallyHidden} htmlFor={`${nameId}-draft`}>
                            {_t("desktop|profile|message_label", { name: displayName })}
                        </label>
                        <input
                            id={`${nameId}-draft`}
                            className={styles.input}
                            value={draft}
                            placeholder={_t("desktop|profile|message_placeholder", { name: displayName })}
                            autoComplete="off"
                            disabled={busy}
                            onChange={(event) => setDraft(event.target.value)}
                        />
                    </form>
                )}
                {error && (
                    <Text as="p" size="sm" role="alert" className={styles.error}>
                        {_t("desktop|profile|message_error")}
                    </Text>
                )}
            </div>
        </section>
    );
}
