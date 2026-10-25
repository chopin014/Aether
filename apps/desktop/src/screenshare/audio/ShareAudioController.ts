/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ScreenShareAudioEvent, ScreenShareAudioRequest } from "shared-types";
import type { ShareAudioProvider, ShareAudioSession, ShareAudioTarget } from "./types.js";

interface Capture {
    id: string;
    session?: ShareAudioSession;
    outstanding: Set<number>;
    sequence: number;
    remainder: Buffer;
    abort: AbortController;
    stopping?: Promise<void>;
}

/** Owns one capture, ties it to approved video, and bounds unacknowledged renderer audio. */
export class ShareAudioController {
    private approvedVideo?: { id: string; at: number };
    private capture?: Capture;

    public constructor(
        public readonly provider: ShareAudioProvider,
        private readonly emit: (event: ScreenShareAudioEvent) => void,
        private readonly excludedProcesses: () => readonly number[],
        private readonly now: () => number = Date.now,
    ) {}

    /** Called only after the main process accepts a video source from the desktop picker. */
    public authorizeVideo = (sourceId: string): void => {
        void this.reset();
        if (sourceId) this.approvedVideo = { id: sourceId, at: this.now() };
    };

    /** Start an explicit audio request against a recent desktop video selection. */
    public start = async (value: unknown): Promise<void> => {
        validateRequest(value);
        const approved = this.approvedVideo;
        if (!approved || approved.id !== value.videoSourceId || this.now() - approved.at > 30_000) {
            throw new Error("Screen audio requires a recent approved video source");
        }
        if (this.capture) throw new Error("Screen audio is already active");
        const capture: Capture = {
            id: value.id,
            outstanding: new Set(),
            sequence: 0,
            remainder: Buffer.alloc(0),
            abort: new AbortController(),
        };
        this.capture = capture;
        // A selection authorizes one capture only, even if native startup fails.
        this.approvedVideo = undefined;
        try {
            let target: ShareAudioTarget;
            if (value.target.kind === "window") {
                const id = await this.provider.resolveWindow(value.videoSourceId);
                if (!id) throw new Error("Audio for this window cannot be identified; select an application instead");
                target = { kind: "application", id };
            } else {
                target = value.target;
            }
            if (this.capture !== capture) throw new Error("Screen audio request was cancelled");
            const session = await this.provider.start(
                target,
                this.excludedProcesses(),
                {
                    onData: (pcm) => this.sendPcm(capture, pcm),
                    onError: (error) => this.finish(capture, error.message),
                    onStopped: () => this.finish(capture),
                },
                capture.abort.signal,
            );
            capture.session = session;
            if (this.capture !== capture) {
                await this.stopSession(capture);
                throw new Error("Screen audio request was cancelled");
            }
        } catch (error) {
            this.finish(capture, error instanceof Error ? error.message : "Screen audio capture failed");
            throw error;
        }
    };

    /** Ignore stale acknowledgements from a previous capture. */
    public acknowledge = (id: unknown, sequence: unknown): void => {
        const capture = this.capture;
        if (capture && capture.id === id && typeof sequence === "number") capture.outstanding.delete(sequence);
    };

    /** Stop is safe during startup and after a native termination. */
    public stop = async (id: unknown): Promise<void> => {
        const capture = this.capture;
        if (!capture || capture.id !== id) return;
        this.finish(capture);
        await this.stopSession(capture);
    };

    /** Revoke permission on navigation, crash, new video selection, hangup, or shutdown. */
    public reset = async (): Promise<void> => {
        this.approvedVideo = undefined;
        const capture = this.capture;
        if (capture) await this.stop(capture.id);
    };

    private finish(capture: Capture, error?: string): void {
        if (this.capture !== capture) return;
        this.capture = undefined;
        capture.remainder = Buffer.alloc(0);
        capture.outstanding.clear();
        capture.abort.abort();
        this.emit({ type: "stopped", id: capture.id, ...(error ? { error } : {}) });
        void this.stopSession(capture).catch(() => undefined);
    }

    private stopSession(capture: Capture): Promise<void> {
        if (!capture.session) return Promise.resolve();
        capture.stopping ??= capture.session.stop();
        return capture.stopping;
    }

    private sendPcm(capture: Capture, pcm: Buffer): void {
        if (this.capture !== capture) return;
        // Pipe chunks may split a stereo frame. Retain at most seven bytes between chunks.
        const data = capture.remainder.length ? Buffer.concat([capture.remainder, pcm]) : pcm;
        const end = data.length - (data.length % 8);
        capture.remainder = Buffer.from(data.subarray(end));
        for (let offset = 0; offset < end && capture.outstanding.size < 8; offset += 7680) {
            const sequence = ++capture.sequence;
            capture.outstanding.add(sequence);
            this.emit({
                type: "data",
                id: capture.id,
                sequence,
                pcm: Uint8Array.from(data.subarray(offset, Math.min(offset + 7680, end))),
            });
        }
    }
}

/** Validate all values crossing the context-isolated renderer boundary. */
export function validateRequest(value: unknown): asserts value is ScreenShareAudioRequest {
    if (!value || typeof value !== "object") throw new Error("Invalid screen audio request");
    const request = value as Partial<ScreenShareAudioRequest>;
    if (
        typeof request.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(request.id) ||
        typeof request.videoSourceId !== "string" ||
        request.videoSourceId.length > 256 ||
        !request.target ||
        typeof request.target !== "object" ||
        !["system", "window", "application"].includes(request.target.kind) ||
        (request.target.kind === "application" &&
            (typeof request.target.id !== "string" || !request.target.id.length || request.target.id.length > 256))
    ) {
        throw new Error("Invalid screen audio request");
    }
}
