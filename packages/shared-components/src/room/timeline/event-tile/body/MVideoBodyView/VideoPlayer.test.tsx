/*
 * Copyright 2026 Gabriel
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE in the repository root for full details.
 */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";

import { VideoPlayer } from "./VideoPlayer";

function getVideo(): HTMLVideoElement {
    return screen.getByLabelText("Clip") as HTMLVideoElement;
}

describe("VideoPlayer", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("replaces the browser's controls with its own", () => {
        render(<VideoPlayer label="Clip" />);

        expect(getVideo()).not.toHaveAttribute("controls");
        expect(getVideo()).toHaveAttribute("controlslist", "nodownload");
        // The large button over the poster and the one in the bar.
        expect(screen.getAllByRole("button", { name: "Play" })).toHaveLength(2);
        expect(screen.getByRole("slider", { name: "Seek" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Full screen" })).toBeInTheDocument();
    });

    it("plays from the play button and then offers to pause", () => {
        const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
            Object.defineProperty(this, "paused", { configurable: true, value: false });
            this.dispatchEvent(new Event("play"));
            return Promise.resolve();
        });
        render(<VideoPlayer label="Clip" src="https://example.org/clip.mp4" />);

        fireEvent.click(screen.getAllByRole("button", { name: "Play" })[0]);

        expect(play).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });

    it("shows the video's length once it is known", () => {
        render(<VideoPlayer label="Clip" />);
        const video = getVideo();

        Object.defineProperty(video, "duration", { configurable: true, value: 75 });
        fireEvent(video, new Event("durationchange"));

        // On the poster, and as the total in the bar.
        expect(screen.getAllByText("1:15")).toHaveLength(2);
        expect(screen.getByRole("slider", { name: "Seek" })).toBeEnabled();
    });

    it("mutes and unmutes with the M key", async () => {
        render(<VideoPlayer label="Clip" />);

        fireEvent.keyDown(screen.getByRole("button", { name: "Mute" }), { key: "m" });

        expect(getVideo().muted).toBe(true);
        expect(await screen.findByRole("button", { name: "Unmute" })).toBeInTheDocument();
    });

    it("leaves Space on a focused button to the button", () => {
        const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        render(<VideoPlayer label="Clip" />);

        fireEvent.keyDown(screen.getByRole("button", { name: "Mute" }), { key: " " });

        expect(play).not.toHaveBeenCalled();
    });

    it("fetches an encrypted video on the first press and plays it as soon as it arrives", () => {
        const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        const onPlayRequest = vi.fn();
        const { rerender } = render(<VideoPlayer label="Clip" src="data:video/mp4," onPlayRequest={onPlayRequest} />);

        fireEvent.click(screen.getAllByRole("button", { name: "Play" })[0]);

        // Asked for once, with a spinner while it decrypts, and no attempt to play the empty placeholder.
        expect(onPlayRequest).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
        expect(play).not.toHaveBeenCalled();

        rerender(<VideoPlayer label="Clip" src="blob:decrypted" onPlayRequest={onPlayRequest} />);
        expect(play).toHaveBeenCalledTimes(1);

        fireEvent(getVideo(), new Event("playing"));
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("starts a video with a real source straight away", () => {
        const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        render(<VideoPlayer label="Clip" src="https://example.org/clip.mp4" />);

        fireEvent.click(screen.getAllByRole("button", { name: "Play" })[0]);

        expect(play).toHaveBeenCalledTimes(1);
    });
});
