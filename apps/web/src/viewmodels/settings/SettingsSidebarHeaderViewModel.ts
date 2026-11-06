/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import {
    BaseViewModel,
    type SettingsSidebarHeaderViewActions,
    type SettingsSidebarHeaderViewSnapshot,
} from "@element-hq/web-shared-components";

import { type OwnProfileStore } from "../../stores/OwnProfileStore";
import { UPDATE_EVENT } from "../../stores/AsyncStore";

export interface SettingsSidebarHeaderViewModelProps {
    client: MatrixClient;
    ownProfileStore: OwnProfileStore;
    /** Called with the search text whenever it changes. */
    onQueryChange: (query: string) => void;
    /** Opens the first page that matches the search. */
    onOpenFirstMatch: () => void;
    /** Opens the profile editor. */
    onEditProfile: () => void;
}

/** Keeps the top of the settings sidebar in step with the user's profile and the search field. */
export class SettingsSidebarHeaderViewModel
    extends BaseViewModel<SettingsSidebarHeaderViewSnapshot, SettingsSidebarHeaderViewModelProps>
    implements SettingsSidebarHeaderViewActions
{
    public constructor(props: SettingsSidebarHeaderViewModelProps) {
        super(props, { ...SettingsSidebarHeaderViewModel.profile(props), query: "" });
        this.disposables.trackListener(props.ownProfileStore, UPDATE_EVENT, this.onProfileUpdate);
    }

    private static profile(
        props: SettingsSidebarHeaderViewModelProps,
    ): Pick<SettingsSidebarHeaderViewSnapshot, "userId" | "displayName" | "avatarUrl"> {
        const userId = props.client.getSafeUserId();
        return {
            userId,
            displayName: props.ownProfileStore.displayName || userId,
            avatarUrl: props.ownProfileStore.getHttpAvatarUrl(72) ?? undefined,
        };
    }

    private onProfileUpdate = (): void => {
        this.snapshot.merge(SettingsSidebarHeaderViewModel.profile(this.props));
    };

    public setQuery = (query: string): void => {
        this.snapshot.merge({ query });
        this.props.onQueryChange(query);
    };

    public openFirstMatch = (): void => {
        this.props.onOpenFirstMatch();
    };

    public editProfile = (): void => {
        this.props.onEditProfile();
    };
}
