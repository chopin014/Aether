/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type PromoteToPeerViewActions,
    type PromoteToPeerViewSnapshot,
} from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import { _t } from "../../languageHandler";

interface Props {
    /** The channel or server whose power levels change. */
    room: Room;
    /** Everyone who would reach the user's own power level. */
    userIds: string[];
    /** Called with whether the user confirmed. */
    onFinished: (confirmed: boolean) => void;
}

/**
 * Compare typed text with the sentence leniently: case, accents, repeated spaces and a closing full stop do not
 * matter, so only the words have to be typed.
 */
export function normalisePhrase(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.!]+$/, "")
        .trim();
}

/** Asks for a typed sentence before people are given the user's own power level. */
export class PromoteToPeerViewModel
    extends BaseViewModel<PromoteToPeerViewSnapshot, Props>
    implements PromoteToPeerViewActions
{
    public constructor(props: Props) {
        super(props, PromoteToPeerViewModel.compute(props));
    }

    private static compute({ room, userIds }: Props): PromoteToPeerViewSnapshot {
        const [only] = userIds;
        const name = userIds.length === 1 ? room.getMember(only)?.rawDisplayName || only : undefined;
        return {
            target: name !== undefined ? { name } : { count: userIds.length },
            roomName: room.name,
            isServer: room.isSpaceRoom(),
            phrase:
                name !== undefined
                    ? _t("desktop|promote_peer|phrase_one", { name })
                    : _t("desktop|promote_peer|phrase_many", { count: userIds.length }),
            typed: "",
            matches: false,
        };
    }

    public setTyped = (typed: string): void => {
        const matches = normalisePhrase(typed) === normalisePhrase(this.snapshot.current.phrase);
        this.snapshot.merge({ typed, matches });
    };

    public confirm = (): void => {
        if (this.snapshot.current.matches) this.props.onFinished(true);
    };

    public cancel = (): void => this.props.onFinished(false);
}
