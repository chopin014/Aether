/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Form } from "@vector-im/compound-web";
import { DesktopProfileEditorView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../../../../../contexts/MatrixClientContext";
import { DesktopProfileEditorViewModel } from "../../../../../viewmodels/profile/DesktopProfileEditorViewModel";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import SettingsFlag from "../../../elements/SettingsFlag";

/** Owns the profile draft for the lifetime of the Profile settings tab. */
export function DesktopProfileEditorSettings(): JSX.Element {
    const client = useMatrixClientContext();
    const vm = useCreateAutoDisposedViewModel(() => new DesktopProfileEditorViewModel({ client }));
    return (
        <div className="mx_DesktopProfileEditorSettings">
            <DesktopProfileEditorView vm={vm} />
            <Form.Root onSubmit={(event) => event.preventDefault()}>
                <SettingsFlag name="showProfileAppearance" level={SettingLevel.DEVICE} />
            </Form.Root>
        </div>
    );
}
