/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { WatchSource } from "./WatchTogetherProtocol";
import type { WatchPlayer, WatchPlayerEvent } from "./WatchPlayer";
import { WatchTogetherSessionEvent, type WatchTogetherSession } from "./WatchTogetherSession";

/** How far a playing player may drift before it is moved; less than this is not noticeable between two homes. */
const PLAYING_TOLERANCE_SECONDS = 0.5;
/** A playing player must be off for this many checks in a row, so one late time report does not cause a seek. */
const DRIFT_CHECKS = 2;
/** A seek during playback lands about this late (measured on YouTube), so it aims this far ahead. */
const SEEK_LEAD_SECONDS = 0.25;
/** A paused player shows the exact frame everyone else sees. */
const PAUSED_TOLERANCE_SECONDS = 0.35;
/** A seek takes a moment to land; correcting again before then makes the player stutter. */
const SEEK_COOLDOWN_MS = 2000;
/**
 * A pause or play the player reports this soon after being told to do something is the result of that command. Any
 * other one is the user clicking the video or pressing a media key, and is shared with everyone.
 */
const COMMAND_ECHO_MS = 1200;
const TICK_MS = 250;
/** A paused player takes about this long to start (measured on YouTube), so a countdown tells it to play early. */
const START_LATENCY_SECONDS = 0.35;

/** Options for {@link WatchPlayerSync}. */
export interface WatchPlayerSyncOptions {
    createPlayer(source: WatchSource): WatchPlayer;
    /** Called whenever the player is replaced, so the view can show the new one. */
    onPlayerChanged(player: WatchPlayer | null): void;
    /** Called after each check, for position and status updates in the view. */
    onTick?(): void;
    now?: () => number;
}

/**
 * Keeps this device's player where the shared session says playback is. It never decides anything itself: it
 * loads, plays, pauses, seeks and changes speed to match, and passes on the changes the user made by interacting
 * with the player directly.
 */
export class WatchPlayerSync {
    private player: WatchPlayer | null = null;
    private unsubscribePlayer?: () => void;
    private timer?: ReturnType<typeof setInterval>;
    private lastCommandAt = -Infinity;
    private lastSeekAt = -Infinity;
    private needsLoad = false;
    private driftChecks = 0;
    /** The session revision this player last caught up with; a newer one is someone's action, applied at once. */
    private appliedRevision = 0;
    private readonly now: () => number;
    private volume = 1;

    public constructor(
        private readonly session: WatchTogetherSession,
        private readonly options: WatchPlayerSyncOptions,
    ) {
        this.now = options.now ?? ((): number => performance.now());
        session.on(WatchTogetherSessionEvent.Changed, this.reconcile);
        this.reconcile();
    }

    public get currentPlayer(): WatchPlayer | null {
        return this.player;
    }

    /** This device's volume, 0 to 1. */
    public setVolume(volume: number): void {
        this.volume = volume;
        this.player?.setVolume(volume);
    }

    /** The player is being moved in the page, which can pause it by itself; that pause is not the user's. */
    public notePlayerMoved(): void {
        this.lastCommandAt = this.now();
    }

    public dispose(): void {
        this.session.off(WatchTogetherSessionEvent.Changed, this.reconcile);
        this.stopTimer();
        this.replacePlayer(null);
    }

    /** Brings the player in line with the session; runs on every change and several times a second while active. */
    public readonly reconcile = (): void => {
        const state = this.session.state;
        const item = this.session.current;
        if (!state || !item) {
            this.stopTimer();
            this.replacePlayer(null);
            return;
        }
        this.startTimer();
        if (!this.player || this.player.source !== item.source) {
            this.replacePlayer(this.options.createPlayer(item.source));
        }
        const player = this.player!;
        const now = this.now();
        const expected = this.session.position(now);
        const target = Math.max(0, expected);
        const shouldPlay = state.playing && !state.ended && expected >= -START_LATENCY_SECONDS;
        const changed = state.revision !== this.appliedRevision;
        this.appliedRevision = state.revision;

        if (player.itemId !== item.id || this.needsLoad) {
            this.needsLoad = false;
            player.load(item, target, shouldPlay);
            if (state.rate !== 1) player.setRate(state.rate);
            this.lastCommandAt = this.lastSeekAt = now;
            this.options.onTick?.();
            return;
        }

        const status = player.status();
        if (!status.ready || status.error) {
            this.options.onTick?.();
            return;
        }
        if (status.rate !== state.rate) player.setRate(state.rate);
        if (shouldPlay && !status.playing) {
            player.play();
            this.lastCommandAt = now;
        } else if (!shouldPlay && status.playing) {
            player.pause();
            this.lastCommandAt = now;
        }
        // A buffering player is behind for a reason; seeking it again only restarts the buffering.
        if (!status.buffering || changed)
            this.correctDrift(player, status.time, status.duration, target, shouldPlay, now, changed);
        this.options.onTick?.();
    };

    /** Moves the player to the shared position when it has drifted, but not while a recent seek is still landing. */
    private correctDrift(
        player: WatchPlayer,
        time: number | null,
        duration: number | null,
        target: number,
        playing: boolean,
        now: number,
        changed: boolean,
    ): void {
        const state = this.session.state!;
        const atEnd = duration !== null && target >= duration - 0.5 && time !== null && time >= duration - 1;
        const tolerance = playing ? PLAYING_TOLERANCE_SECONDS : PAUSED_TOLERANCE_SECONDS;
        if (time === null || state.ended || atEnd || Math.abs(time - target) <= tolerance) {
            this.driftChecks = 0;
            return;
        }
        // Someone's seek is applied straight away; slow drift is confirmed first and corrected at most so often.
        if (!changed) {
            if (now - this.lastSeekAt < SEEK_COOLDOWN_MS) return;
            if (playing && ++this.driftChecks < DRIFT_CHECKS) return;
        }
        this.driftChecks = 0;
        player.seek(playing ? target + SEEK_LEAD_SECONDS * state.rate : target);
        this.lastCommandAt = this.lastSeekAt = now;
    }

    private readonly onPlayerEvent = (event: WatchPlayerEvent): void => {
        const player = this.player;
        const item = this.session.current;
        const state = this.session.state;
        if (!player || !item || !state || player.itemId !== item.id) return;
        const now = this.now();
        switch (event) {
            case "ended":
                this.session.itemEnded(item.id);
                break;
            case "reset":
                this.needsLoad = true;
                this.reconcile();
                break;
            case "paused":
            case "playing": {
                const playing = event === "playing";
                if (now - this.lastCommandAt < COMMAND_ECHO_MS || playing === state.playing || state.ended) break;
                // During the countdown to a new item the player sits paused on purpose.
                if (!playing && this.session.position(now) < 0) break;
                this.session.setPlaying(playing, player.status().time ?? undefined);
                break;
            }
            default:
                this.options.onTick?.();
        }
    };

    private replacePlayer(player: WatchPlayer | null): void {
        if (player === this.player) return;
        this.unsubscribePlayer?.();
        this.unsubscribePlayer = undefined;
        this.player?.dispose();
        this.player = player;
        this.needsLoad = false;
        if (player) {
            player.setVolume(this.volume);
            this.unsubscribePlayer = player.subscribe(this.onPlayerEvent);
        }
        this.options.onPlayerChanged(player);
    }

    private startTimer(): void {
        this.timer ??= setInterval(this.reconcile, TICK_MS);
    }

    private stopTimer(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }
}
