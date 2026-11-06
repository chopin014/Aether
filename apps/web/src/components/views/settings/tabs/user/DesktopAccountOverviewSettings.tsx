/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useCallback, useContext, useEffect, useState } from "react";
import { ThreepidMedium } from "matrix-js-sdk/src/matrix";
import { AccountOverviewView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../../../../../contexts/MatrixClientContext";
import { type ThirdPartyIdentifier } from "../../../../../AddThreepid";
import { UserSettingsNavigationContext } from "../../../../../contexts/UserSettingsNavigationContext";
import { AccountOverviewViewModel } from "../../../../../viewmodels/settings/AccountOverviewViewModel";
import { AddRemoveThreepids } from "../../AddRemoveThreepids";
import ChangePassword from "../../ChangePassword";
import InlineSpinner from "../../../elements/InlineSpinner";

interface Props {
    /** The account provider's site, when the account is managed there. */
    externalAccountManagementUrl?: string;
    canChangePassword: boolean;
    canMake3pidChanges: boolean;
    canDeactivate: boolean;
    onDeactivate: () => void;
    onPasswordChanged: () => void;
    onPasswordChangeError: (e: Error) => void;
}

/** Adds and removes the account's email addresses. */
function EmailEditor(): JSX.Element {
    const client = useMatrixClientContext();
    const [emails, setEmails] = useState<ThirdPartyIdentifier[]>();

    const load = useCallback(async () => {
        const { threepids } = await client.getThreePids();
        setEmails(threepids.filter((t) => t.medium === ThreepidMedium.Email));
    }, [client]);

    useEffect(() => {
        void load();
    }, [load]);

    if (!emails) return <InlineSpinner />;
    return (
        <AddRemoveThreepids
            mode="hs"
            medium={ThreepidMedium.Email}
            threepids={emails}
            onChange={load}
            isLoading={false}
        />
    );
}

/** The desktop shell's account overview, which owns its view model for as long as the Account tab is open. */
export function DesktopAccountOverviewSettings({
    externalAccountManagementUrl,
    canChangePassword,
    canMake3pidChanges,
    canDeactivate,
    onDeactivate,
    onPasswordChanged,
    onPasswordChangeError,
}: Props): JSX.Element {
    const client = useMatrixClientContext();
    const openTab = useContext(UserSettingsNavigationContext);
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new AccountOverviewViewModel({
                client,
                accountManagementUrl: externalAccountManagementUrl,
                canChangePassword,
                canChangeEmails: canMake3pidChanges,
                canDeactivate,
                openTab,
                onDeactivate,
            }),
    );

    // The tab learns what the server allows after the first render.
    useEffect(() => {
        vm.setCapabilities({
            accountManagementUrl: externalAccountManagementUrl,
            canChangePassword,
            canChangeEmails: canMake3pidChanges,
            canDeactivate,
        });
    }, [vm, externalAccountManagementUrl, canChangePassword, canMake3pidChanges, canDeactivate]);

    const onPasswordFinished = useCallback(() => {
        vm.closePasswordEditor();
        onPasswordChanged();
    }, [vm, onPasswordChanged]);

    return (
        <AccountOverviewView
            vm={vm}
            emailEditor={<EmailEditor />}
            passwordEditor={
                <ChangePassword
                    rowClassName=""
                    buttonKind="primary"
                    onError={onPasswordChangeError}
                    onFinished={onPasswordFinished}
                />
            }
        />
    );
}
