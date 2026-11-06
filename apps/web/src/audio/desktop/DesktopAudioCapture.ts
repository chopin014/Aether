/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { DesktopAudioApi, DesktopAudioPacket } from "shared-types";

import { DesktopVoicePipeline } from "./DesktopVoicePipeline";
import { keepRealtimeClock } from "./keepRealtimeClock";
import SettingsStore from "../../settings/SettingsStore";

/** Decode native interleaved PCM without applying microphone processing to shared audio. */
export function decodeDesktopAudio(packet: DesktopAudioPacket, context: AudioContext): AudioBuffer {
    const bytes = packet.bitsPerSample / 8;
    if (
        ![2, 4].includes(bytes) ||
        (packet.isFloat && bytes !== 4) ||
        !Number.isFinite(packet.sampleRate) ||
        packet.sampleRate <= 0 ||
        !Number.isInteger(packet.channels) ||
        packet.data.byteLength === 0 ||
        packet.channels < 1 ||
        packet.channels > 8 ||
        packet.data.byteLength % (bytes * packet.channels)
    ) {
        throw new Error("Unsupported desktop audio format");
    }
    const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
    const frames = packet.data.byteLength / (bytes * packet.channels);
    const buffer = context.createBuffer(packet.channels, frames, packet.sampleRate);
    for (let channel = 0; channel < packet.channels; channel++) {
        const output = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; frame++) {
            const offset = (frame * packet.channels + channel) * bytes;
            output[frame] = packet.isFloat
                ? view.getFloat32(offset, true)
                : bytes === 2
                  ? view.getInt16(offset, true) / 32768
                  : view.getInt32(offset, true) / 2147483648;
        }
    }
    return buffer;
}

/** Attach native source audio to display capture, including preferences changed while the picker was open. */
export function installDesktopAudioCapture(api: DesktopAudioApi): void {
    const devices = navigator.mediaDevices;
    if (!devices?.getDisplayMedia) return;
    const getDisplayMedia = devices.getDisplayMedia.bind(devices);
    devices.getDisplayMedia = async (options): Promise<MediaStream> => {
        if (!SettingsStore.getValue("feature_desktop_shell")) return getDisplayMedia(options);
        // Native capture owns audio selection; Chromium must only capture the selected video source.
        await api.prepare(DesktopVoicePipeline.instance.getScreenShareQuality().includeSystemAudio);
        const stream = await getDisplayMedia({ ...options, audio: false });
        const sessionId = crypto.randomUUID();
        let context: AudioContext | undefined;
        let unsubscribe = (): void => {};
        let closed = false;
        const scheduled = new Set<AudioBufferSourceNode>();
        const close = (): void => {
            if (closed) return;
            closed = true;
            unsubscribe();
            for (const node of scheduled) node.stop();
            scheduled.clear();
            void api.stop(sessionId).catch(() => {});
            if (context) void context.close();
        };
        try {
            context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
            const destination = context.createMediaStreamDestination();
            // Playback is scheduled against this context's clock, which must keep real time.
            keepRealtimeClock(context);
            let nextTime = 0;
            unsubscribe = api.onData((packet) => {
                if (closed || packet.sessionId !== sessionId) return;
                try {
                    const buffer = decodeDesktopAudio(packet, context!);
                    // Bound latency after a suspended renderer instead of accumulating stale playback.
                    if (nextTime > context!.currentTime + 0.15) return;
                    nextTime = Math.max(context!.currentTime + 0.01, nextTime);
                    const node = context!.createBufferSource();
                    node.buffer = buffer;
                    node.connect(destination);
                    node.onended = () => {
                        scheduled.delete(node);
                        node.disconnect();
                    };
                    scheduled.add(node);
                    node.start(nextTime);
                    nextTime += buffer.duration;
                } catch {
                    close();
                    for (const track of stream.getTracks()) track.stop();
                }
            });
            if (!(await api.start(sessionId))) {
                close();
                return stream;
            }
            await context.resume();
            const audio = destination.stream.getAudioTracks()[0];
            audio.contentHint = "music";
            stream.addTrack(audio);
            for (const track of stream.getTracks()) {
                const stop = track.stop.bind(track);
                track.stop = (): void => {
                    stop();
                    close();
                };
                track.addEventListener("ended", close, { once: true });
            }
            return stream;
        } catch (error) {
            close();
            for (const track of stream.getTracks()) track.stop();
            throw error;
        }
    };
}
