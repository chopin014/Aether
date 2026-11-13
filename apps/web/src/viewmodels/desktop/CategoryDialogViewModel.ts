/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type CategoryDialogViewActions,
    type CategoryDialogViewSnapshot,
} from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { _t } from "../../languageHandler";
import { normaliseCategoryName } from "../../stores/space-layout/SpaceLayout";
import { createCategory, renameCategory } from "../../stores/space-layout/spaceLayoutActions";

interface Props {
    /** The server the category belongs to. */
    space: Room;
    /** The category to rename; a new one is created when left out. */
    categoryId?: string;
    /** Its current name, shown to edit. */
    currentName?: string;
    onFinished: () => void;
}

/** Creates a server category, or renames one, from the name typed in its dialog. */
export class CategoryDialogViewModel
    extends BaseViewModel<CategoryDialogViewSnapshot, Props>
    implements CategoryDialogViewActions
{
    public constructor(props: Props) {
        const name = props.currentName ?? "";
        super(props, {
            mode: props.categoryId ? "rename" : "create",
            name,
            canSubmit: normaliseCategoryName(name) !== undefined,
            busy: false,
        });
    }

    public setName = (name: string): void => {
        this.snapshot.merge({ name, canSubmit: normaliseCategoryName(name) !== undefined, error: undefined });
    };

    public submit = async (): Promise<void> => {
        const { name, canSubmit, busy } = this.snapshot.current;
        if (!canSubmit || busy) return;
        const { space, categoryId, currentName } = this.props;
        if (categoryId && normaliseCategoryName(name) === currentName) {
            this.props.onFinished();
            return;
        }

        this.snapshot.merge({ busy: true, error: undefined });
        try {
            if (categoryId) await renameCategory(space, categoryId, name);
            else await createCategory(space, name);
            this.props.onFinished();
        } catch (error) {
            logger.warn("Failed to save a server category", error);
            this.snapshot.merge({ busy: false, error: _t("desktop|categories|save_failed") });
        }
    };

    public cancel = (): void => {
        this.props.onFinished();
    };
}
