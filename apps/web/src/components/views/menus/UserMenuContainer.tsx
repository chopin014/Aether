/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useContext, useEffect } from "react";
import {
    DesktopAccountDockView,
    UserMenu,
    useCreateAutoDisposedViewModel,
    useViewModel,
} from "@element-hq/web-shared-components";

import { SDKContext } from "../../../contexts/SDKContext";
import { UserMenuViewModel } from "../../../viewmodels/menus/UserMenuViewModel";
import { OwnProfileStore } from "../../../stores/OwnProfileStore";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { useDispatcher } from "../../../hooks/useDispatcher";
import { useHeightCustomProperty } from "../../../hooks/useHeightCustomProperty";
import { type ResizerViewModel } from "../../../viewmodels/structures/ResizerViewModel";

import { CallStore } from "../../../stores/CallStore";
import { DesktopVoiceControlsViewModel } from "../../../viewmodels/desktop/DesktopVoiceControlsViewModel";

import { Action } from "../../../dispatcher/actions";

interface UserMenuContainerProps {
    /** Whether the Space rail is collapsed. */
    isPanelCollapsed: boolean;
    /** Place the existing account actions in the desktop footer. */
    desktopDock?: boolean;
}

/** Own the real account menu model in either the rail or the desktop footer. */
export function UserMenuContainer({ isPanelCollapsed, desktopDock = false }: UserMenuContainerProps): JSX.Element {
    const { client } = useContext(SDKContext);
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new UserMenuViewModel(
                { ownProfileStore: OwnProfileStore.instance },
                defaultDispatcher,
                client!,
                isPanelCollapsed,
            ),
    );

    useDispatcher(defaultDispatcher, (payload) => {
        if (payload.action === Action.ToggleUserMenu) vm.setOpen(!vm.getSnapshot().open);
    });

    useEffect(() => {
        vm.setExpanded(!isPanelCollapsed);
    }, [vm, isPanelCollapsed]);

    return desktopDock ? <DesktopDockWithVoice vm={vm} /> : <UserMenu vm={vm} className="mx_UserMenu" />;
}

function DesktopDockWithVoice({ vm }: { vm: UserMenuViewModel }): JSX.Element {
    const { client } = useContext(SDKContext);
    const voice = useCreateAutoDisposedViewModel(
        () => new DesktopVoiceControlsViewModel({ client: client!, callStore: CallStore.instance }),
    );
    return <DesktopAccountDockView vm={vm} voice={voice} />;
}

/** Positions the account controls across the rail and the measured, resizable channel sidebar. */
export function DesktopAccountDockContainer({ vm }: { vm: ResizerViewModel }): JSX.Element | null {
    const { isCollapsed, leftPanelWidth } = useViewModel(vm);
    // The lists the dock floats over keep their last rows clear of it, however tall the voice controls make it.
    const dockRef = useHeightCustomProperty("--mx-desktop-dock-height");
    if (isCollapsed) return null;
    return (
        <div ref={dockRef} className="mx_DesktopShell_accountDock" style={{ width: (leftPanelWidth ?? 310) + 64 - 16 }}>
            <UserMenuContainer isPanelCollapsed={false} desktopDock />
        </div>
    );
}
