/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactElement, useContext } from "react";
import { type Room } from "matrix-js-sdk/src/matrix";
import { ContextMenu } from "@vector-im/compound-web";
import { ServerMenuView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { SDKContext } from "../../../contexts/SDKContext";
import { ServerMenuViewModel } from "../../../viewmodels/desktop/ServerMenuViewModel";

/** The menu's entries, with a view model that lives only while the menu is open. */
function ServerMenuContent({ space }: { space: Room }): JSX.Element {
    const client = useMatrixClientContext();
    const { spaceStore } = useContext(SDKContext);
    const vm = useCreateAutoDisposedViewModel(() => new ServerMenuViewModel({ space, client, spaceStore }));
    return <ServerMenuView vm={vm} />;
}

interface Props {
    /** The server the menu is for. */
    space: Room;
    /** The server's button in the rail, which right-clicking opens the menu on. */
    children: ReactElement;
}

/**
 * The menu a server opens in the desktop rail when right-clicked, as in Discord. The server's own menu, above its
 * channel list, offers the same to keyboard users.
 */
export function DesktopServerContextMenu({ space, children }: Props): JSX.Element {
    return (
        <ContextMenu title={space.name} hasAccessibleAlternative={true} trigger={children}>
            <ServerMenuContent space={space} />
        </ContextMenu>
    );
}
