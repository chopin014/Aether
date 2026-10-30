// @vitest-environment jsdom
/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "test-utils-rtl";
import { TypedEventEmitter, type MatrixClient } from "matrix-js-sdk/src/matrix";

import MatrixClientContext from "../contexts/MatrixClientContext";
import SettingsStore from "../settings/SettingsStore";
import { RICH_PROFILE_FIELD } from "./richProfile";
import { useRichProfile, useRichRowProfile } from "./useRichProfile";

const ROBIN = "@robin:example.org";

vi.mock("../customisations/Media", () => ({
    mediaFromMxc: (mxc: string) => ({ srcHttp: mxc, getThumbnailOfSourceHttp: () => mxc }),
}));

function makeClient(ignored = false): MatrixClient {
    return Object.assign(new TypedEventEmitter<string, any>(), {
        doesServerSupportExtendedProfiles: vi.fn().mockResolvedValue(true),
        getExtendedProfile: vi.fn().mockResolvedValue({ [RICH_PROFILE_FIELD]: { decoration: "halo" } }),
        isUserIgnored: () => ignored,
        getRoom: () => null,
    }) as unknown as MatrixClient;
}

describe("useRichProfile", () => {
    const render = <T,>(client: MatrixClient, hook: () => T): { current: T } =>
        renderHook(hook, {
            wrapper: ({ children }) => (
                <MatrixClientContext.Provider value={client}>{children}</MatrixClientContext.Provider>
            ),
        }).result;

    const useSettings = (settings: Record<string, boolean>): void => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            ((name: string) => settings[name] ?? false) as typeof SettingsStore.getValue,
        );
    };

    beforeEach(() => {
        useSettings({ feature_desktop_shell: true, showProfileAppearance: true });
    });

    it("fetches a person's profile and delivers it", async () => {
        const client = makeClient();
        const result = render(client, () => useRichProfile(ROBIN));
        expect(result.current).toBeUndefined();
        await waitFor(() => expect(result.current?.decoration).toBe("halo"));
        expect(client.getExtendedProfile).toHaveBeenCalledWith(ROBIN);
    });

    it("asks for nothing without a user", () => {
        const client = makeClient();
        expect(render(client, () => useRichProfile(undefined)).current).toBeUndefined();
        expect(client.getExtendedProfile).not.toHaveBeenCalled();
    });

    // Chat export renders message tiles to static HTML, which throws for a store hook with no server snapshot.
    it("can render to static HTML", () => {
        function Tile(): JSX.Element {
            return <span>{useRichProfile(ROBIN)?.decoration ?? "plain"}</span>;
        }
        const html = renderToStaticMarkup(
            <MatrixClientContext.Provider value={makeClient()}>
                <Tile />
            </MatrixClientContext.Provider>,
        );
        expect(html).toBe("<span>plain</span>");
    });

    describe("useRichRowProfile", () => {
        it("gives a row what it draws", async () => {
            const result = render(makeClient(), () => useRichRowProfile(ROBIN));
            await waitFor(() => expect(result.current?.appearance?.decoration).toBe("halo"));
        });

        it.each([
            ["outside the desktop shell", { feature_desktop_shell: false, showProfileAppearance: true }],
            ["when the viewer turned styling off", { feature_desktop_shell: true, showProfileAppearance: false }],
            [
                "on a low bandwidth connection",
                { feature_desktop_shell: true, showProfileAppearance: true, lowBandwidth: true },
            ],
        ])("asks the server for nothing %s", (_, settings) => {
            useSettings(settings);
            const client = makeClient();
            expect(render(client, () => useRichRowProfile(ROBIN)).current).toBeUndefined();
            expect(client.getExtendedProfile).not.toHaveBeenCalled();
        });

        it("shows nothing for an ignored person", async () => {
            const client = makeClient(true);
            const result = render(client, () => useRichRowProfile(ROBIN));
            await waitFor(() => expect(client.getExtendedProfile).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(result.current).toBeUndefined();
        });
    });
});
