/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

/** Space state type, keyed by sound ID so concurrent uploads cannot overwrite each other. */
export const SOUNDBOARD_EVENT = "io.aether.soundboard.sound";
/** Short-lived playback requests; audio files remain in the media repository. */
export const SOUNDBOARD_PLAY = "io.aether.soundboard.play";
/** Upload and playback limits apply on receivers as well as senders. */
export const SOUNDBOARD_MAX_BYTES = 512_000;
/** Maximum duration in seconds. */
export const SOUNDBOARD_MAX_DURATION = 10;

/** Original Aether sounds, available without uploads. */
export const BUILTIN_SOUNDS = [
    {
        id: "airhorn",
        name: "Airhorn",
        emoji: "🔊",
        url: new URL("../../../res/media/aether/soundboard-airhorn.wav", import.meta.url).href,
    },
    {
        id: "quack",
        name: "Quack",
        emoji: "🦆",
        url: new URL("../../../res/media/aether/soundboard-quack.wav", import.meta.url).href,
    },
    {
        id: "sad-horn",
        name: "Sad horn",
        emoji: "🎺",
        url: new URL("../../../res/media/aether/soundboard-sad-horn.wav", import.meta.url).href,
    },
    {
        id: "cricket",
        name: "Cricket",
        emoji: "🦗",
        url: new URL("../../../res/media/aether/soundboard-cricket.wav", import.meta.url).href,
    },
    {
        id: "golf-clap",
        name: "Golf clap",
        emoji: "👏",
        url: new URL("../../../res/media/aether/soundboard-golf-clap.wav", import.meta.url).href,
    },
    {
        id: "ba-dum-tss",
        name: "Ba dum tss",
        emoji: "🥁",
        url: new URL("../../../res/media/aether/soundboard-ba-dum-tss.wav", import.meta.url).href,
    },
] as const;

/** Validated metadata stored in a Space or channel. State metadata is not encrypted by Matrix. */
export interface StoredSound {
    name: string;
    emoji: string;
    url: string;
    duration_ms: number;
}

/** Ignore malformed or removed entries received from the homeserver. */
export function parseSound(content: Record<string, unknown>): StoredSound | undefined {
    if (
        typeof content.name !== "string" ||
        !content.name.trim() ||
        content.name.length > 32 ||
        typeof content.emoji !== "string" ||
        content.emoji.length > 16 ||
        typeof content.url !== "string" ||
        !/^mxc:\/\/[^/]+\/[^/?#]+$/.test(content.url) ||
        typeof content.duration_ms !== "number" ||
        !Number.isSafeInteger(content.duration_ms) ||
        content.duration_ms <= 0 ||
        content.duration_ms > SOUNDBOARD_MAX_DURATION * 1000
    )
        return;
    return { name: content.name, emoji: content.emoji, url: content.url, duration_ms: content.duration_ms };
}

/** Joined Spaces contribute their libraries to every call, alongside the call room itself. */
export function soundboardRooms(client: MatrixClient, room: Room): Room[] {
    return [
        room,
        ...(client.getRooms() ?? []).filter((space) => space.isSpaceRoom() && space.getMyMembership() === "join"),
    ];
}

/** Preloaded call audio, with a bounded cache and independent playback for each sound. */
export class SoundboardAudio {
    private static readonly cacheLimit = 24;
    private readonly cache = new Map<string, { audio: HTMLAudioElement; objectUrl?: string }>();
    private readonly pending = new Map<
        string,
        {
            abort: AbortController;
            promise: Promise<{ audio: HTMLAudioElement; objectUrl?: string }>;
        }
    >();
    private queue: string[] = [];
    private preparing = 0;
    private disposed = false;
    private readonly playing = new Map<
        string,
        { audio?: HTMLAudioElement; ended?: () => void; timeout?: ReturnType<typeof setTimeout> }
    >();

    /** Stop all current and pending playback while retaining prepared sounds for the next click. */
    public stop = (): void => {
        for (const source of this.playing.keys()) this.stopSource(source);
    };

    private stopSource(source: string): void {
        const playback = this.playing.get(source);
        if (!playback) return;
        this.playing.delete(source);
        clearTimeout(playback.timeout);
        playback.ended?.();
        if (playback.audio) {
            playback.audio.onended = null;
            playback.audio.onerror = null;
            playback.audio.pause();
        }
    }

    /** Cancel preparation and release cached audio when the call's last owner leaves. */
    public dispose = (): void => {
        this.disposed = true;
        this.stop();
        this.queue = [];
        for (const pending of this.pending.values()) pending.abort.abort();
        this.pending.clear();
        for (const entry of this.cache.values()) this.release(entry);
        this.cache.clear();
    };

    /** Warm likely sounds on both senders and receivers, with at most two Matrix downloads in flight. */
    public preload(client: MatrixClient, sources: readonly string[], output: string): void {
        if (this.disposed) return;
        this.queue = [...new Set(sources)]
            .slice(0, SoundboardAudio.cacheLimit)
            .filter((source) => !this.cache.has(source) && !this.pending.has(source));
        this.prepareNext(client, output);
    }

    private prepareNext(client: MatrixClient, output: string): void {
        while (!this.disposed && this.preparing < 2 && this.queue.length) {
            const source = this.queue.shift()!;
            this.preparing++;
            void this.getAudio(client, source)
                .then(async ({ audio }) => {
                    if (!this.disposed && output && audio.setSinkId && audio.sinkId !== output) {
                        await audio.setSinkId(output);
                    }
                })
                // A failed prefetch must not interrupt the call; playback retries and reports errors on click.
                .catch(() => {})
                .finally(() => {
                    this.preparing--;
                    this.prepareNext(client, output);
                });
        }
    }

    /** Decode before uploading so unsupported or long files never become library entries. */
    public static async duration(file: Blob): Promise<number> {
        if (!file.size || file.size > SOUNDBOARD_MAX_BYTES) throw new Error("size");
        const context = new AudioContext();
        try {
            const buffer = await context.decodeAudioData(await file.arrayBuffer());
            if (buffer.duration <= 0 || buffer.duration > SOUNDBOARD_MAX_DURATION) throw new Error("duration");
            return buffer.duration;
        } finally {
            await context.close();
        }
    }

    private release(entry: { audio: HTMLAudioElement; objectUrl?: string }): void {
        entry.audio.pause();
        entry.audio.removeAttribute("src");
        entry.audio.load();
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    }

    private getAudio(client: MatrixClient, source: string): Promise<{ audio: HTMLAudioElement; objectUrl?: string }> {
        if (this.disposed) return Promise.reject(new Error("disposed"));
        const cached = this.cache.get(source);
        if (cached) {
            this.cache.delete(source);
            this.cache.set(source, cached);
            return Promise.resolve(cached);
        }
        const existing = this.pending.get(source);
        if (existing) return existing.promise;
        const abort = new AbortController();
        const promise = this.load(client, source, abort.signal)
            .then((entry) => {
                if (this.disposed || abort.signal.aborted) {
                    this.release(entry);
                    throw new Error("disposed");
                }
                this.cache.set(source, entry);
                if (this.cache.size > SoundboardAudio.cacheLimit) {
                    // Preserve playing clips where possible, but keep the cache bounded even when all are active.
                    const oldest =
                        [...this.cache].find(([key]) => !this.playing.has(key)) ??
                        [...this.cache].find(([key]) => key !== source)!;
                    this.stopSource(oldest[0]);
                    this.cache.delete(oldest[0]);
                    this.release(oldest[1]);
                }
                return entry;
            })
            .finally(() => this.pending.delete(source));
        this.pending.set(source, { promise, abort });
        return promise;
    }

    /** Authenticate and validate uploaded media once before retaining its local playback URL. */
    private async load(
        client: MatrixClient,
        source: string,
        signal: AbortSignal,
    ): Promise<{
        audio: HTMLAudioElement;
        objectUrl?: string;
    }> {
        let url = source;
        let objectUrl: string | undefined;
        if (source.startsWith("mxc://")) {
            // Authenticated downloads are required here; Media.srcHttp uses the legacy public URL.
            // oxlint-disable-next-line no-restricted-properties
            const download = client.mxcUrlToHttp(source, undefined, undefined, undefined, false, false, true);
            if (!download) throw new Error("media");
            const response = await fetch(download, {
                headers: { Authorization: `Bearer ${client.getAccessToken()}` },
                signal,
            });
            if (!response.ok || !response.body) throw new Error("media");
            const reader = response.body.getReader();
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let size = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > SOUNDBOARD_MAX_BYTES) throw new Error("size");
                    chunks.push(new Uint8Array(value));
                }
            } finally {
                await reader.cancel();
            }
            const blob = new Blob(chunks);
            await SoundboardAudio.duration(blob);
            if (signal.aborted) throw new Error("disposed");
            objectUrl = URL.createObjectURL(blob);
            url = objectUrl;
        }
        const audio = new Audio(url);
        audio.preload = "auto";
        audio.load();
        return { audio, objectUrl };
    }

    /**
     * Overlap different sounds; restart the same sound without waiting for its previous playback.
     * onStarted returns a cleanup for activity indicators, called whenever that playback ends or stops.
     */
    public async play(
        client: MatrixClient,
        source: string,
        volume: number,
        output: string,
        onStarted?: () => () => void,
    ): Promise<void> {
        this.stopSource(source);
        const playback: { audio?: HTMLAudioElement; ended?: () => void; timeout?: ReturnType<typeof setTimeout> } = {};
        this.playing.set(source, playback);
        try {
            const { audio } = await this.getAudio(client, source);
            if (this.playing.get(source) !== playback || this.disposed) return;
            playback.audio = audio;
            audio.currentTime = 0;
            audio.volume = Math.max(0, Math.min(1, volume));
            if (audio.setSinkId && audio.sinkId !== output && (output || audio.sinkId)) await audio.setSinkId(output);
            if (this.playing.get(source) !== playback) return;
            await audio.play();
            if (this.playing.get(source) !== playback) return;
            playback.ended = onStarted?.();
            audio.onerror = () => {
                if (this.playing.get(source) === playback) this.stopSource(source);
            };
            audio.onended = () => {
                if (this.playing.get(source) === playback) this.stopSource(source);
            };
            playback.timeout = setTimeout(() => {
                if (this.playing.get(source) === playback) this.stopSource(source);
            }, SOUNDBOARD_MAX_DURATION * 1000);
        } catch (error) {
            // Restarting or stopping a sound can reject an earlier play() promise in the browser.
            if (this.playing.get(source) !== playback) return;
            this.stopSource(source);
            throw error;
        }
    }
}
