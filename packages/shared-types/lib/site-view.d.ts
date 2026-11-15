/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** What the best video on the shared site is doing. */
export interface SiteVideoState {
    paused: boolean;
    ended: boolean;
    buffering: boolean;
    /** Position in seconds when the state was read. */
    time: number;
    duration: number | null;
    rate: number;
}

/** The embedded site as the desktop host sees it. */
export interface SiteViewState {
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    /** The video being synced, or null while none has been found on the page. */
    video: SiteVideoState | null;
}

/** Something the site's video did, which may have been the user clicking the site's own controls. */
export type SiteVideoEvent = "playing" | "paused" | "seeked" | "ended" | "ratechange";

export type SiteViewEvent =
    | { type: "state"; state: SiteViewState }
    | { type: "video"; event: SiteVideoEvent }
    /** The page asked to show its video fullscreen, or stopped. */
    | { type: "fullscreen"; on: boolean }
    /** A still frame of the site as a data URL, shown while the view is hidden behind the app's own menus. */
    | { type: "snapshot"; dataUrl: string };

export type SiteViewCommand =
    | { play: true }
    | { pause: true }
    | { seek: number }
    | { rate: number }
    /** 0 to 1; 0 also mutes everything else the site plays. */
    | { volume: number };

/** In CSS pixels of the app window. */
export interface SiteViewBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The desktop host's embedded browser for watching a website together. One per app window. */
export interface SiteViewApi {
    /** Shows the site, creating the view if needed, or navigates the existing one. */
    open: (url: string) => Promise<void>;
    /** Places the view over the app, or hides it (it keeps playing) with null. */
    setBounds: (bounds: SiteViewBounds | null) => void;
    command: (command: SiteViewCommand) => void;
    goBack: () => void;
    /** Closes the view and stops everything playing in it. */
    close: () => void;
    onEvent: (listener: (event: SiteViewEvent) => void) => () => void;
}
