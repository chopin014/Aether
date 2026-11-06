/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useId, useRef } from "react";
import { Button, InlineSpinner, Text, TextInput } from "@vector-im/compound-web";
import {
    ChevronRightIcon,
    ExploreIcon,
    GroupIcon,
    PlusIcon,
    PublicIcon,
    TakePhotoSolidIcon,
    UserAddSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import styles from "./CreateServerView.module.css";

/** Which screen of the flow is showing. */
export type CreateServerStep = "start" | "audience" | "customise" | "join";

/** Who the new server is for: friends join by invite, a community is open to anyone with the link. */
export type CreateServerAudience = "friends" | "community";

/** Everything the server creation and joining flow shows. */
export interface CreateServerViewSnapshot {
    /** The screen that is showing. */
    step: CreateServerStep;
    /** Whether the user may choose a community server, which anyone can join. */
    canChooseAudience: boolean;
    /** Whether the homeserver can list public servers to explore. */
    canExplore: boolean;
    /** Who the server is for. */
    audience: CreateServerAudience;
    /** The server's name. */
    name: string;
    /** A preview of the chosen icon. */
    avatarUrl?: string;
    /** The invite link or address typed on the join screen. */
    joinAddress: string;
    /** Whether the server is being created. */
    busy: boolean;
    /** What creation is doing now. */
    progress?: string;
    /** Why the last attempt failed. */
    error?: string;
}

/** What the flow's controls do. */
export interface CreateServerViewActions {
    /** Go from the first screen to creating a server. */
    startCreate: () => void;
    /** Go from the first screen to joining a server with an invite. */
    startJoin: () => void;
    /** Choose who the server is for and move on to naming it. */
    chooseAudience: (audience: CreateServerAudience) => void;
    /** Return to the previous screen. */
    back: () => void;
    /** Change the server's name. */
    setName: (name: string) => void;
    /** Choose the server's icon. */
    setAvatar: (file: File) => void;
    /** Create the server with a text and a voice channel. */
    create: () => void;
    /** Change the typed invite. */
    setJoinAddress: (address: string) => void;
    /** Open the typed invite and join it. */
    join: () => void;
    /** Browse public servers instead. */
    explore: () => void;
}

/** The model behind the server creation and joining flow. */
export type CreateServerViewModel = ViewModel<CreateServerViewSnapshot, CreateServerViewActions>;

interface OptionProps {
    icon: ReactNode;
    label: string;
    description?: string;
    onClick: () => void;
}

/** A full-width choice with an icon and a chevron. */
function Option({ icon, label, description, onClick }: OptionProps): JSX.Element {
    return (
        <button type="button" className={styles.option} onClick={onClick}>
            <span className={styles.optionIcon} aria-hidden>
                {icon}
            </span>
            <span className={styles.optionText}>
                <Text as="span" weight="semibold">
                    {label}
                </Text>
                {description && (
                    <Text as="span" size="md" className={styles.secondary}>
                        {description}
                    </Text>
                )}
            </span>
            <ChevronRightIcon className={styles.chevron} aria-hidden />
        </button>
    );
}

function Header({ title, description }: { title: string; description: string }): JSX.Element {
    return (
        <header className={styles.header}>
            <Text as="h2" size="lg" weight="semibold" className={styles.title}>
                {title}
            </Text>
            <Text as="p" className={styles.secondary}>
                {description}
            </Text>
        </header>
    );
}

function Footer({ onBack, children }: { onBack?: () => void; children?: ReactNode }): JSX.Element {
    return (
        <footer className={styles.footer}>
            {onBack ? (
                <Button type="button" kind="tertiary" size="md" onClick={onBack}>
                    {_t("action|back")}
                </Button>
            ) : (
                <span />
            )}
            {children}
        </footer>
    );
}

/**
 * A Discord-style flow for adding a server: create your own (who it is for, then its name and icon) or join one with
 * an invite. The host supplies the dialog around it.
 */
export function CreateServerView({
    vm,
}: {
    /** The flow's model. */
    vm: CreateServerViewModel;
}): JSX.Element {
    const s = useViewModel(vm);
    const fileInput = useRef<HTMLInputElement>(null);
    const nameId = useId();
    const joinId = useId();

    switch (s.step) {
        case "start":
            return (
                <div className={styles.content}>
                    <Header
                        title={_t("desktop|create_server|start_title")}
                        description={_t("desktop|create_server|start_description")}
                    />
                    <Option
                        icon={<PlusIcon />}
                        label={_t("desktop|create_server|create_own")}
                        onClick={vm.startCreate}
                    />
                    <div className={styles.joinSection}>
                        <Text as="h3" size="md" weight="semibold" className={styles.title}>
                            {_t("desktop|create_server|have_invite")}
                        </Text>
                        <Button type="button" kind="secondary" onClick={vm.startJoin}>
                            {_t("desktop|create_server|join_server")}
                        </Button>
                        {s.canExplore && (
                            <Button type="button" kind="tertiary" size="md" Icon={ExploreIcon} onClick={vm.explore}>
                                {_t("desktop|create_server|explore")}
                            </Button>
                        )}
                    </div>
                </div>
            );

        case "audience":
            return (
                <div className={styles.content}>
                    <Header
                        title={_t("desktop|create_server|audience_title")}
                        description={_t("desktop|create_server|audience_description")}
                    />
                    <Option
                        icon={<GroupIcon />}
                        label={_t("desktop|create_server|audience_friends")}
                        description={_t("desktop|create_server|audience_friends_description")}
                        onClick={() => vm.chooseAudience("friends")}
                    />
                    <Option
                        icon={<PublicIcon />}
                        label={_t("desktop|create_server|audience_community")}
                        description={_t("desktop|create_server|audience_community_description")}
                        onClick={() => vm.chooseAudience("community")}
                    />
                    <Text as="p" size="md" className={styles.centred}>
                        {_t(
                            "desktop|create_server|audience_skip",
                            {},
                            {
                                skip: (sub) => (
                                    <button
                                        type="button"
                                        className={styles.link}
                                        onClick={() => vm.chooseAudience("friends")}
                                    >
                                        {sub}
                                    </button>
                                ),
                            },
                        )}
                    </Text>
                    <Footer onBack={vm.back} />
                </div>
            );

        case "customise":
            return (
                <form
                    className={styles.content}
                    aria-busy={s.busy}
                    onSubmit={(event) => {
                        event.preventDefault();
                        vm.create();
                    }}
                >
                    <Header
                        title={_t("desktop|create_server|customise_title")}
                        description={_t("desktop|create_server|customise_description")}
                    />
                    <div className={styles.avatarRow}>
                        <button
                            type="button"
                            className={styles.avatar}
                            onClick={() => fileInput.current?.click()}
                            disabled={s.busy}
                            aria-label={_t("desktop|create_server|upload_icon")}
                        >
                            {s.avatarUrl ? (
                                <img src={s.avatarUrl} alt="" className={styles.avatarImage} />
                            ) : (
                                <>
                                    <TakePhotoSolidIcon className={styles.avatarIcon} aria-hidden />
                                    <Text as="span" size="xs" weight="semibold">
                                        {_t("desktop|create_server|upload")}
                                    </Text>
                                </>
                            )}
                            <span className={styles.avatarBadge} aria-hidden>
                                <PlusIcon />
                            </span>
                        </button>
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/*"
                            hidden
                            data-testid="server-icon-input"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) vm.setAvatar(file);
                                event.target.value = "";
                            }}
                        />
                    </div>
                    <label className={styles.field} htmlFor={nameId}>
                        <Text as="span" size="md" weight="semibold">
                            {_t("desktop|create_server|name_label")}
                            <span className={styles.required} aria-hidden>
                                {" *"}
                            </span>
                        </Text>
                        <TextInput
                            id={nameId}
                            value={s.name}
                            onChange={(event) => vm.setName(event.target.value)}
                            disabled={s.busy}
                            required
                            autoFocus
                            autoComplete="off"
                            maxLength={100}
                        />
                    </label>
                    <Text as="p" size="md" className={styles.secondary}>
                        {_t("desktop|create_server|starter_channels")}
                    </Text>
                    {s.error && (
                        <Text as="p" size="md" role="alert" className={styles.error}>
                            {s.error}
                        </Text>
                    )}
                    <div role="status" className={styles.progress}>
                        {s.busy && (
                            <>
                                <InlineSpinner />
                                {s.progress}
                            </>
                        )}
                    </div>
                    <Footer onBack={s.busy ? undefined : vm.back}>
                        <Button type="submit" kind="primary" disabled={s.busy || !s.name.trim()}>
                            {_t("action|create")}
                        </Button>
                    </Footer>
                </form>
            );

        case "join":
            return (
                <form
                    className={styles.content}
                    onSubmit={(event) => {
                        event.preventDefault();
                        vm.join();
                    }}
                >
                    <Header
                        title={_t("desktop|create_server|join_title")}
                        description={_t("desktop|create_server|join_description")}
                    />
                    <label className={styles.field} htmlFor={joinId}>
                        <Text as="span" size="md" weight="semibold">
                            {_t("desktop|create_server|invite_label")}
                            <span className={styles.required} aria-hidden>
                                {" *"}
                            </span>
                        </Text>
                        <TextInput
                            id={joinId}
                            value={s.joinAddress}
                            onChange={(event) => vm.setJoinAddress(event.target.value)}
                            placeholder="https://matrix.to/#/#aether:matrix.org"
                            required
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </label>
                    {s.error && (
                        <Text as="p" size="md" role="alert" className={styles.error}>
                            {s.error}
                        </Text>
                    )}
                    <div className={styles.examples}>
                        <Text as="h3" size="md" weight="semibold" className={styles.title}>
                            {_t("desktop|create_server|invite_examples")}
                        </Text>
                        <Text as="p" size="md" className={styles.secondary}>
                            https://matrix.to/#/#aether:matrix.org
                        </Text>
                        <Text as="p" size="md" className={styles.secondary}>
                            #aether:matrix.org
                        </Text>
                    </div>
                    <Footer onBack={vm.back}>
                        <Button type="submit" kind="primary" Icon={UserAddSolidIcon} disabled={!s.joinAddress.trim()}>
                            {_t("desktop|create_server|join_server")}
                        </Button>
                    </Footer>
                </form>
            );
    }
}
