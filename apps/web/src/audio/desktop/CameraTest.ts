/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import MediaDeviceHandler from "../../MediaDeviceHandler";

/** Opens the chosen camera so the settings can show it, and closes it again on {@link stop}. */
export class CameraTest {
    private stream: MediaStream | null = null;
    private starting = false;

    public get active(): boolean {
        return this.stream !== null;
    }

    /**
     * @returns the camera stream, or null when the test was stopped before the camera opened.
     * @throws the reason from `getUserMedia` when the camera cannot be opened.
     */
    public async start(): Promise<MediaStream | null> {
        this.stop();
        this.starting = true;
        const deviceId = MediaDeviceHandler.getVideoInput();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: deviceId && deviceId !== "default" ? { exact: deviceId } : undefined },
            });
            if (!this.starting) {
                stream.getTracks().forEach((track) => track.stop());
                return null;
            }
            this.stream = stream;
            return stream;
        } finally {
            this.starting = false;
        }
    }

    public stop(): void {
        this.starting = false;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
    }
}
