/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, InlineSpinner, Text, TextInput } from "@vector-im/compound-web";
import { SpaceIcon, VolumeOnIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import { TextChannelIcon } from "../TextChannelIcon";
import styles from "./DeleteServerView.module.css";

/** Confirmation and progress for deleting a server and its complete room hierarchy. */
export interface DeleteServerViewSnapshot {
    /** Server name to enter for confirmation. */
    name: string;
    /** Rooms and nested servers affected, excluding the root server. */
    rooms: { id: string; name: string; kind: "text" | "voice" | "space" }[];
    /** Whether the permission checks or deletion are running. */
    busy: boolean;
    /** Whether the complete hierarchy has passed preflight. */
    ready: boolean;
    /** The entered server name. */
    confirmation: string;
    /** Current operation, including the affected room. */
    progress?: string;
    /** A permission or operation failure. */
    error?: string;
}

/** Actions for the server deletion confirmation. */
export interface DeleteServerViewActions {
    /** Update the entered confirmation. */
    setConfirmation: (value: string) => void;
    /** Delete the server, resume deletion, or retry failed permission checks. */
    confirm: () => void;
    /** Close when no operation is running. */
    cancel: () => void;
}

/** Model contract for the server deletion confirmation. */
export type DeleteServerViewModel = ViewModel<DeleteServerViewSnapshot, DeleteServerViewActions>;

/** Confirmation content; the host supplies the dialog title. */
export function DeleteServerView({ vm }: { /** The confirmation's model. */ vm: DeleteServerViewModel }): JSX.Element {
    const s = useViewModel(vm);
    return (
        <div className={styles.content} aria-busy={s.busy}>
            <Text as="p">{_t("desktop|delete_server|description", { name: s.name })}</Text>
            <Text as="p" size="sm" className={styles.note}>
                {_t("desktop|delete_server|history_note")}
            </Text>
            {s.ready && (
                <>
                    <Text as="p" weight="semibold">
                        {_t("desktop|delete_server|affected", { count: s.rooms.length })}
                    </Text>
                    {s.rooms.length > 0 && (
                        <ul className={styles.rooms} aria-label={_t("desktop|delete_server|room_list")}>
                            {s.rooms.map((room) => {
                                const Icon =
                                    room.kind === "space"
                                        ? SpaceIcon
                                        : room.kind === "voice"
                                          ? VolumeOnIcon
                                          : TextChannelIcon;
                                return (
                                    <li key={room.id}>
                                        <Icon aria-hidden />
                                        <span>{room.name}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <label className={styles.confirmation}>
                        <Text as="span" size="sm">
                            {_t("desktop|delete_server|confirm_name", { name: s.name })}
                        </Text>
                        <TextInput
                            value={s.confirmation}
                            onChange={(event) => vm.setConfirmation(event.target.value)}
                            disabled={s.busy}
                            autoComplete="off"
                        />
                    </label>
                </>
            )}
            {s.error && (
                <Text as="p" role="alert" className={styles.error}>
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
            <div className={styles.actions}>
                <Button kind="secondary" onClick={vm.cancel} disabled={s.busy} autoFocus>
                    {_t("action|cancel")}
                </Button>
                <Button
                    kind="destructive"
                    onClick={vm.confirm}
                    disabled={s.busy || (s.ready ? s.confirmation !== s.name : !s.error)}
                >
                    {s.error ? _t("action|retry") : _t("desktop|delete_server|delete")}
                </Button>
            </div>
        </div>
    );
}
