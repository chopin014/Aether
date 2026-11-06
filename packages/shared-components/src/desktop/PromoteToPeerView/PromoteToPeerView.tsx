/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Text, TextInput } from "@vector-im/compound-web";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import styles from "./PromoteToPeerView.module.css";

/** What the confirmation shows before someone is given the user's own power level. */
export interface PromoteToPeerViewSnapshot {
    /** Who is being promoted: one person's name, or how many people. */
    target: { name: string } | { count: number };
    /** The channel or server the promotion applies to. */
    roomName: string;
    /** Whether the promotion applies to a whole server rather than one channel. */
    isServer: boolean;
    /** The sentence, in the user's language, that must be typed to confirm. */
    phrase: string;
    /** What the user has typed so far. */
    typed: string;
    /** Whether the typed text matches the sentence. */
    matches: boolean;
}

/** The actions of the confirmation. */
export interface PromoteToPeerViewActions {
    /** Update the typed text. */
    setTyped: (value: string) => void;
    /** Give the power level; only acts once the sentence matches. */
    confirm: () => void;
    /** Keep the current power levels. */
    cancel: () => void;
}

/** The model behind the confirmation. */
export type PromoteToPeerViewModel = ViewModel<PromoteToPeerViewSnapshot, PromoteToPeerViewActions>;

/**
 * Asks the user to type a sentence before giving someone the same power level as their own, since that cannot be
 * undone. Pasting is refused so the sentence has to be read and typed. The host supplies the dialog and its title.
 */
export function PromoteToPeerView({
    vm,
}: {
    /** The confirmation's model. */
    vm: PromoteToPeerViewModel;
}): JSX.Element {
    const s = useViewModel(vm);
    const who = "name" in s.target ? s.target.name : _t("desktop|promote_peer|people", { count: s.target.count });
    return (
        <form
            className={styles.content}
            onSubmit={(event) => {
                event.preventDefault();
                vm.confirm();
            }}
        >
            <Text as="p">
                {s.isServer
                    ? _t("desktop|promote_peer|description_server", { who, room: s.roomName })
                    : _t("desktop|promote_peer|description_channel", { who, room: s.roomName })}
            </Text>
            <ul className={styles.consequences}>
                <li>{_t("desktop|promote_peer|can_delete")}</li>
                <li>{_t("desktop|promote_peer|can_change_roles")}</li>
                <li>{_t("desktop|promote_peer|irreversible")}</li>
            </ul>
            <label className={styles.confirmation}>
                <Text as="span" size="sm" weight="semibold">
                    {_t("desktop|promote_peer|type_to_confirm")}
                </Text>
                <Text as="span" className={styles.phrase} data-testid="promote-peer-phrase">
                    {s.phrase}
                </Text>
                <TextInput
                    value={s.typed}
                    onChange={(event) => vm.setTyped(event.target.value)}
                    // The sentence has to be typed, so pasting or dropping text is ignored.
                    onPaste={(event) => event.preventDefault()}
                    onDrop={(event) => event.preventDefault()}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="promote-peer-hint"
                />
                <Text as="span" size="sm" id="promote-peer-hint" className={styles.note}>
                    {_t("desktop|promote_peer|no_paste")}
                </Text>
            </label>
            <div className={styles.actions}>
                <Button type="button" kind="secondary" onClick={vm.cancel}>
                    {_t("action|cancel")}
                </Button>
                <Button type="submit" kind="destructive" disabled={!s.matches}>
                    {_t("desktop|promote_peer|confirm")}
                </Button>
            </div>
        </form>
    );
}
