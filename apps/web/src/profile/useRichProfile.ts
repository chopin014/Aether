/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
    type DesktopProfileAppearance,
    type DesktopProfileTag,
    type UserStatus,
} from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../contexts/MatrixClientContext";
import { useFeatureEnabled, useSettingValue } from "../hooks/useSettings";
import { type RichProfile } from "./richProfile";
import { RichProfileStore } from "./RichProfileStore";
import { appearanceFromRichProfile } from "./richProfileView";
import { wornSpaceTag } from "./spaceTag";

const NOTHING = (): void => {};
const NO_SUBSCRIPTION = (): (() => void) => NOTHING;

/** A person's validated profile, fetched when first needed. Undefined until it arrives or when nothing was asked for. */
export function useRichProfile(userId: string | undefined): RichProfile | undefined {
    const client = useMatrixClientContext();
    // Rows render this hook in every mode, so nothing touches the client until a profile is really wanted.
    const store = useMemo(() => (userId ? RichProfileStore.forClient(client) : undefined), [client, userId]);
    const subscribe = useCallback(
        (listener: () => void) => (store && userId ? store.subscribe(userId, listener) : NOTHING),
        [store, userId],
    );
    const getSnapshot = (): RichProfile | undefined => (store && userId ? store.get(userId) : undefined);
    // Chat export renders tiles to static HTML, where React asks for the server snapshot and throws if there is none.
    const profile = useSyncExternalStore(store ? subscribe : NO_SUBSCRIPTION, getSnapshot, getSnapshot);
    useEffect(() => {
        if (store && userId) void store.request(userId);
    }, [store, userId]);
    return profile;
}

/** What a compact row (a member list entry or a message's sender) draws for a person. */
export interface RichRowProfile {
    appearance?: DesktopProfileAppearance;
    status?: UserStatus;
    tag?: DesktopProfileTag;
}

/**
 * The parts of a profile a compact row shows. Only asks the server in the desktop shell, and shows nothing for ignored
 * people or when the viewer has turned other people's profile styling off.
 */
export function useRichRowProfile(userId: string | undefined): RichRowProfile | undefined {
    const client = useMatrixClientContext();
    const desktopShell = useFeatureEnabled("feature_desktop_shell");
    const enabled = useSettingValue("showProfileAppearance");
    const lowBandwidth = useSettingValue("lowBandwidth");
    const active = desktopShell && enabled && !lowBandwidth;
    const profile = useRichProfile(active ? userId : undefined);
    return useMemo(() => {
        if (!profile || !userId || client.isUserIgnored(userId)) return undefined;
        return {
            appearance: appearanceFromRichProfile(profile, undefined),
            status: profile.status,
            tag: wornSpaceTag(client, profile, userId),
        };
    }, [client, profile, userId]);
}
