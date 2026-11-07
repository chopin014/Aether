/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import Modal from "../../Modal";
import { _t } from "../../languageHandler";
import ErrorDialog from "../../components/views/dialogs/ErrorDialog";
import QuestionDialog from "../../components/views/dialogs/QuestionDialog";
import { DesktopCategoryDialog } from "../../components/views/desktop/DesktopCategoryDialog";
import { deleteCategory } from "../../stores/space-layout/spaceLayoutActions";

/*
 * The dialogs around a server's categories, shared by the channel list's menu and each category's menu.
 */

/** Ask for a name and create a category at the end of the server's list. */
export function showCreateCategory(space: Room): void {
    Modal.createDialog(DesktopCategoryDialog, { space });
}

/** Ask for a new name for a category. */
export function showRenameCategory(space: Room, categoryId: string, currentName: string): void {
    Modal.createDialog(DesktopCategoryDialog, { space, categoryId, currentName });
}

/** Tell the person a change to the server's channel list did not go through. */
export function reportLayoutError(error: unknown): void {
    logger.warn("Failed to change a server's channel layout", error);
    Modal.createDialog(ErrorDialog, {
        title: _t("desktop|categories|error_title"),
        description: _t("desktop|categories|error_description"),
    });
}

/** Ask before deleting a category, as Discord does; its channels stay, at the top of the list. */
export async function confirmDeleteCategory(space: Room, categoryId: string, name: string): Promise<void> {
    const { finished } = Modal.createDialog(QuestionDialog, {
        title: _t("desktop|categories|delete_title"),
        description: _t("desktop|categories|delete_description", { category: name }),
        button: _t("desktop|categories|delete"),
        danger: true,
    });
    const [confirmed] = await finished;
    if (!confirmed) return;
    try {
        await deleteCategory(space, categoryId);
    } catch (error) {
        reportLayoutError(error);
    }
}
