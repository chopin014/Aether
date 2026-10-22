/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Text } from "@vector-im/compound-web";
import { GroupIcon, HomeSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import styles from "./DesktopTitlebarView.module.css";

/** Context already maintained by the room-list header model. */
export interface DesktopTitlebarViewSnapshot {
    title: string;
    displaySpaceMenu: boolean;
}

/** The native titlebar follows the selected Matrix Space or Home. */
export function DesktopTitlebarView({ vm }: { vm: ViewModel<DesktopTitlebarViewSnapshot> }): JSX.Element {
    const { title, displaySpaceMenu } = useViewModel(vm);
    const Icon = displaySpaceMenu ? GroupIcon : HomeSolidIcon;
    return (
        <div className={styles.identity}>
            <Icon aria-hidden />
            <Text as="span" size="sm" weight="semibold">
                {title}
            </Text>
        </div>
    );
}
