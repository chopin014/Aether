/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { WatchItem, WatchSource } from "./WatchTogetherProtocol";

/** Why this device cannot play the current item. */
export type WatchPlayerError = "not_embeddable" | "not_found" | "unplayable" | "needs_desktop";

/** What the player last reported, with the time projected forward to now while it plays. */
export interface WatchPlayerStatus {
    /** The player can take commands for the loaded item. */
    readonly ready: boolean;
    /** Playing, or trying to while it buffers. */
    readonly playing: boolean;
    readonly buffering: boolean;
    /** Current position in seconds, or null before the player has said. */
    readonly time: number | null;
    readonly duration: number | null;
    readonly rate: number;
    /** The player's own title for the item, which can be more accurate than the one shared with it. */
    readonly title?: string;
    /** False for an audio-only file, so the view can show artwork instead of a black frame. */
    readonly hasVideo: boolean;
    readonly error?: WatchPlayerError;
}

/** Something the player did, which may not have been asked for: someone may have clicked the video itself. */
export type WatchPlayerEvent =
    | "playing"
    | "paused"
    | "ended"
    | "error"
    | "status"
    | "reset"
    /** The position jumped; on a website this is usually someone using the site's own progress bar. */
    | "seeked"
    | "ratechange";

/** One kind of media player embedded in the call stage; the shared session tells it what to do. */
export interface WatchPlayer {
    /** The element shown in the call stage; it stays the same for the player's whole life. */
    readonly element: HTMLElement;
    readonly source: WatchSource;
    /** The item last loaded, or null before the first. */
    readonly itemId: string | null;
    /** What the last load pointed at; a website item can be pointed at another page. */
    readonly itemRef: string | null;
    load(item: WatchItem, position: number, play: boolean): void;
    play(): void;
    pause(): void;
    seek(position: number): void;
    setRate(rate: number): void;
    /** This device's volume, 0 to 1; never shared. */
    setVolume(volume: number): void;
    status(): WatchPlayerStatus;
    subscribe(listener: (event: WatchPlayerEvent) => void): () => void;
    dispose(): void;
}
