/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, ThreepidMedium } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import {
    BaseViewModel,
    type AccountOverviewViewActions,
    type AccountOverviewViewSnapshot,
    type DesktopProfileIdentitySnapshot,
} from "@element-hq/web-shared-components";
import { copyPlainTextToClipboard } from "@element-hq/element-web-shared-utils";

import { mediaFromMxc } from "../../customisations/Media";
import { RichProfileStore } from "../../profile/RichProfileStore";
import { appearanceFromRichProfile } from "../../profile/richProfileView";
import SettingsStore from "../../settings/SettingsStore";
import { UserTab } from "../../components/views/dialogs/UserTab";

/** How long the copy button says "Copied". */
const COPIED_MS = 2000;

export interface AccountOverviewViewModelProps {
    client: MatrixClient;
    /** The account provider's site, when the account is managed there rather than on the homeserver. */
    accountManagementUrl?: string;
    /** Whether the homeserver lets the user change their password here. */
    canChangePassword: boolean;
    /** Whether the homeserver lets the user add or remove email addresses. */
    canChangeEmails: boolean;
    /** Whether the account can be deactivated from here. */
    canDeactivate: boolean;
    /** Opens another settings tab. */
    openTab: (tab: UserTab) => void;
    /** Starts deactivating the account. */
    onDeactivate: () => void;
}

/** Feeds the account overview: the user's profile, email addresses, sessions and how they sign in. */
export class AccountOverviewViewModel
    extends BaseViewModel<AccountOverviewViewSnapshot, AccountOverviewViewModelProps>
    implements AccountOverviewViewActions
{
    private copiedTimer?: ReturnType<typeof setTimeout>;

    public constructor(props: AccountOverviewViewModelProps) {
        super(props, {
            identity: AccountOverviewViewModel.identity(props.client),
            emails: [],
            canChangeEmails: props.canChangeEmails,
            ...AccountOverviewViewModel.password(props),
            canDeactivate: props.canDeactivate || !!props.accountManagementUrl,
            copied: false,
        });
        const userId = props.client.getSafeUserId();
        const store = RichProfileStore.forClient(props.client);
        this.disposables.track(store.subscribe(userId, this.refreshIdentity));
        void store.request(userId);
        this.disposables.track(() => clearTimeout(this.copiedTimer));
        void this.loadEmails();
        void this.loadSessionCount();
    }

    /** The user's own profile card, read from the profile the app already keeps for them. */
    private static identity(client: MatrixClient): DesktopProfileIdentitySnapshot {
        const userId = client.getSafeUserId();
        const raw = RichProfileStore.forClient(client).getRaw(userId);
        const rich = RichProfileStore.forClient(client).get(userId);
        const user = client.getUser(userId);
        const name = (typeof raw?.displayname === "string" && raw.displayname) || user?.displayName || userId;
        const mxc = (typeof raw?.avatar_url === "string" && raw.avatar_url) || user?.avatarUrl || undefined;
        return {
            userId,
            displayName: name,
            avatarUrl: mxc ? (mediaFromMxc(mxc).getThumbnailOfSourceHttp(160, 160, "crop") ?? undefined) : undefined,
            roles: [],
            appearance:
                rich && SettingsStore.getValue("showProfileAppearance")
                    ? appearanceFromRichProfile(rich, mxc)
                    : undefined,
        };
    }

    private static password(
        props: AccountOverviewViewModelProps,
    ): Pick<AccountOverviewViewSnapshot, "password" | "accountManagementHost"> {
        if (props.accountManagementUrl) {
            let host: string | undefined;
            try {
                host = new URL(props.accountManagementUrl).host;
            } catch {
                host = undefined;
            }
            return { password: "managed", accountManagementHost: host };
        }
        return { password: props.canChangePassword ? "change" : "none" };
    }

    /** Updates the snapshot when the server reports what this account can do. */
    public setCapabilities(
        capabilities: Pick<
            AccountOverviewViewModelProps,
            "accountManagementUrl" | "canChangePassword" | "canChangeEmails" | "canDeactivate"
        >,
    ): void {
        Object.assign(this.props, capabilities);
        this.snapshot.merge({
            ...AccountOverviewViewModel.password(this.props),
            canChangeEmails: capabilities.canChangeEmails,
            canDeactivate: capabilities.canDeactivate || !!capabilities.accountManagementUrl,
        });
    }

    private refreshIdentity = (): void => {
        this.snapshot.merge({ identity: AccountOverviewViewModel.identity(this.props.client) });
    };

    private async loadEmails(): Promise<void> {
        try {
            const { threepids } = await this.props.client.getThreePids();
            if (this.isDisposed) return;
            this.snapshot.merge({
                emails: threepids.filter((t) => t.medium === ThreepidMedium.Email).map((t) => t.address),
            });
        } catch (e) {
            logger.warn("Could not read the account's email addresses", e);
        }
    }

    private async loadSessionCount(): Promise<void> {
        try {
            const { devices } = await this.props.client.getDevices();
            if (this.isDisposed) return;
            this.snapshot.merge({ sessionCount: devices.length });
        } catch (e) {
            logger.warn("Could not count the account's sessions", e);
        }
    }

    public editProfile = (): void => {
        this.props.openTab(UserTab.Profile);
    };

    public copyUserId = (): void => {
        void copyPlainTextToClipboard(this.props.client.getSafeUserId()).then((copied) => {
            if (!copied || this.isDisposed) return;
            this.snapshot.merge({ copied: true });
            clearTimeout(this.copiedTimer);
            this.copiedTimer = setTimeout(() => this.snapshot.merge({ copied: false }), COPIED_MS);
        });
    };

    public toggleEmailEditor = (): void => {
        const closing = this.snapshot.current.editing === "email";
        this.snapshot.merge({ editing: closing ? undefined : "email" });
        // Addresses added or removed in the editor show up in the row once it closes.
        if (closing) void this.loadEmails();
    };

    public togglePasswordEditor = (): void => {
        this.snapshot.merge({ editing: this.snapshot.current.editing === "password" ? undefined : "password" });
    };

    /** Closes the password form, after the password was changed. */
    public closePasswordEditor = (): void => {
        this.snapshot.merge({ editing: undefined });
    };

    public manageAccount = (): void => {
        if (this.props.accountManagementUrl) window.open(this.props.accountManagementUrl, "_blank", "noopener");
    };

    public openSessions = (): void => {
        this.props.openTab(UserTab.SessionManager);
    };

    /** Deactivates here, or on the account provider's site when the account is managed there. */
    public deactivate = (): void => {
        const { accountManagementUrl } = this.props;
        if (!accountManagementUrl) {
            this.props.onDeactivate();
            return;
        }
        const url = new URL(accountManagementUrl);
        url.searchParams.set("action", "org.matrix.account_deactivate");
        window.open(url.toString(), "_blank", "noopener");
    };
}
