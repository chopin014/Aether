/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient, ThreepidMedium } from "matrix-js-sdk/src/matrix";
import { flushPromises, stubClient } from "test-utils";
import * as sharedUtils from "@element-hq/element-web-shared-utils";

import { AccountOverviewViewModel, type AccountOverviewViewModelProps } from "./AccountOverviewViewModel";
import { RichProfileStore } from "../../profile/RichProfileStore";
import { UserTab } from "../../components/views/dialogs/UserTab";

vi.mock("@element-hq/element-web-shared-utils", async (importOriginal) => ({
    ...(await importOriginal<typeof sharedUtils>()),
    copyPlainTextToClipboard: vi.fn().mockResolvedValue(true),
}));

describe("AccountOverviewViewModel", () => {
    let client: MatrixClient;
    let vm: AccountOverviewViewModel | undefined;

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getThreePids").mockResolvedValue({
            threepids: [
                { medium: ThreepidMedium.Email, address: "chopin@example.org", validated_at: 0, added_at: 0 },
                { medium: ThreepidMedium.Phone, address: "5511999999999", validated_at: 0, added_at: 0 },
            ],
        });
        vi.spyOn(client, "getDevices").mockResolvedValue({ devices: [{ device_id: "A" }, { device_id: "B" }] } as any);
        vi.spyOn(RichProfileStore.forClient(client), "request").mockResolvedValue(undefined);
    });

    afterEach(() => {
        vm?.dispose();
        vm = undefined;
        vi.restoreAllMocks();
    });

    const create = (props: Partial<AccountOverviewViewModelProps> = {}): AccountOverviewViewModel => {
        vm = new AccountOverviewViewModel({
            client,
            canChangePassword: true,
            canChangeEmails: true,
            canDeactivate: true,
            openTab: vi.fn(),
            onDeactivate: vi.fn(),
            ...props,
        });
        return vm;
    };

    it("lists the account's email addresses and counts its sessions", async () => {
        const model = create();
        await flushPromises();

        expect(model.getSnapshot().emails).toEqual(["chopin@example.org"]);
        expect(model.getSnapshot().sessionCount).toBe(2);
        expect(model.getSnapshot().identity.userId).toBe(client.getSafeUserId());
    });

    it("changes the password here when the server allows it", () => {
        expect(create().getSnapshot().password).toBe("change");
    });

    it("sends people to their account provider when it manages the account", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        const onDeactivate = vi.fn();
        const model = create({
            accountManagementUrl: "https://account.matrix.org/account/",
            canDeactivate: false,
            onDeactivate,
        });

        expect(model.getSnapshot()).toMatchObject({
            password: "managed",
            accountManagementHost: "account.matrix.org",
            canDeactivate: true,
        });
        model.manageAccount();
        expect(open).toHaveBeenCalledWith("https://account.matrix.org/account/", "_blank", "noopener");
        model.deactivate();
        expect(open).toHaveBeenLastCalledWith(
            "https://account.matrix.org/account/?action=org.matrix.account_deactivate",
            "_blank",
            "noopener",
        );
        expect(onDeactivate).not.toHaveBeenCalled();
    });

    it("deactivates here when the homeserver manages the account", () => {
        const onDeactivate = vi.fn();
        create({ onDeactivate }).deactivate();
        expect(onDeactivate).toHaveBeenCalled();
    });

    it("cannot change the password or deactivate when the server allows neither", () => {
        expect(create({ canChangePassword: false, canDeactivate: false }).getSnapshot()).toMatchObject({
            password: "none",
            canDeactivate: false,
        });
    });

    it("follows what the server allows once it is known", () => {
        const model = create({ canChangePassword: false, canChangeEmails: false });
        model.setCapabilities({ canChangePassword: true, canChangeEmails: true, canDeactivate: false });
        expect(model.getSnapshot()).toMatchObject({ password: "change", canChangeEmails: true, canDeactivate: false });
    });

    it("opens the profile editor and the session list", () => {
        const openTab = vi.fn();
        const model = create({ openTab });
        model.editProfile();
        model.openSessions();
        expect(openTab.mock.calls).toEqual([[UserTab.Profile], [UserTab.SessionManager]]);
    });

    it("opens one editor at a time and reloads the addresses when the email editor closes", async () => {
        const model = create();
        await flushPromises();

        model.toggleEmailEditor();
        expect(model.getSnapshot().editing).toBe("email");
        model.togglePasswordEditor();
        expect(model.getSnapshot().editing).toBe("password");
        model.closePasswordEditor();
        expect(model.getSnapshot().editing).toBeUndefined();

        model.toggleEmailEditor();
        model.toggleEmailEditor();
        await flushPromises();
        expect(model.getSnapshot().editing).toBeUndefined();
        expect(client.getThreePids).toHaveBeenCalledTimes(2);
    });

    it("says the user ID was copied for a moment", async () => {
        vi.useFakeTimers();
        try {
            const model = create();
            model.copyUserId();
            await vi.advanceTimersByTimeAsync(0);
            expect(sharedUtils.copyPlainTextToClipboard).toHaveBeenCalledWith(client.getSafeUserId());
            expect(model.getSnapshot().copied).toBe(true);
            await vi.advanceTimersByTimeAsync(2000);
            expect(model.getSnapshot().copied).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
