/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { MockViewModel } from "../../core/viewmodel";
import {
    formatPlaybackTime,
    WatchTogetherPanel,
    WatchTogetherPlayer,
    type WatchTogetherViewSnapshot,
} from "./WatchTogetherView";

const queue = [
    {
        id: "i1",
        title: "Big Buck Bunny",
        subtitle: "Blender",
        thumbnailUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg",
        addedBy: "Alice",
        current: true,
    },
    { id: "i2", title: "Me at the zoo", subtitle: "jawed", addedBy: "Bob", current: false },
];

function makeVm(overrides: Partial<WatchTogetherViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<WatchTogetherViewSnapshot>({
            connected: true,
            active: true,
            title: "Big Buck Bunny",
            subtitle: "Blender",
            addedBy: "Alice",
            thumbnailUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg",
            sourceName: "YouTube",
            playing: true,
            ended: false,
            startingIn: null,
            buffering: false,
            hasVideo: true,
            embedHandlesClicks: true,
            position: 83,
            duration: 634,
            rate: 1,
            rates: [0.5, 1, 1.5, 2],
            hasPrevious: false,
            hasNext: true,
            queue,
            volume: 70,
            deafened: false,
            draft: "",
            adding: false,
            ...overrides,
        }),
        {
            setDraft: vi.fn(),
            submitDraft: vi.fn(),
            addLink: vi.fn(),
            togglePlaying: vi.fn(),
            seek: vi.fn(),
            setRate: vi.fn(),
            next: vi.fn(),
            previous: vi.fn(),
            playItem: vi.fn(),
            removeItem: vi.fn(),
            stop: vi.fn(),
            setVolume: vi.fn(),
            attachPlayer: vi.fn(),
            openSource: vi.fn(),
        },
    );
}

/** Renders the player and waits a frame, by which time it has found its tile and is shown. */
async function renderPlayer(vm: ReturnType<typeof makeVm>, compact = false) {
    const onFocus = vi.fn();
    const onOpenQueue = vi.fn();
    const slotRef = createRef<HTMLDivElement>();
    const containerRef = createRef<HTMLDivElement>();
    render(
        <div ref={containerRef}>
            <div ref={slotRef} />
            <WatchTogetherPlayer
                vm={vm}
                slotRef={slotRef}
                containerRef={containerRef}
                compact={compact}
                onFocus={onFocus}
                onOpenQueue={onOpenQueue}
            />
        </div>,
    );
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    return { onFocus, onOpenQueue };
}

describe("formatPlaybackTime", () => {
    it.each([
        [0, "0:00"],
        [83.9, "1:23"],
        [3723, "1:02:03"],
        [-5, "0:00"],
    ])("formats %s as %s", (seconds, text) => {
        expect(formatPlaybackTime(seconds)).toBe(text);
    });
});

describe("WatchTogetherPlayer", () => {
    it("hands the view model a place for the player and takes it back on unmount", async () => {
        const vm = makeVm();
        const { unmount } = render(
            <WatchTogetherPlayer
                vm={vm}
                slotRef={createRef()}
                containerRef={createRef()}
                compact={false}
                onFocus={vi.fn()}
                onOpenQueue={vi.fn()}
            />,
        );
        expect(vm.attachPlayer).toHaveBeenCalledWith(expect.any(HTMLDivElement));
        unmount();
        expect(vm.attachPlayer).toHaveBeenLastCalledWith(null);
    });

    it("shows what is playing and controls it for everyone", async () => {
        const vm = makeVm();
        const { onOpenQueue } = await renderPlayer(vm);
        expect(screen.getByText("Big Buck Bunny")).toBeInTheDocument();
        expect(screen.getByText("YouTube · Blender · added by Alice")).toBeInTheDocument();
        expect(screen.getByText("1:23 / 10:34")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Pause for everyone" }));
        expect(vm.togglePlaying).toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(vm.next).toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Queue (2 items)" }));
        expect(onOpenQueue).toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "End for everyone" }));
        expect(vm.stop).toHaveBeenCalled();
    });

    it("seeks when the progress bar is released", async () => {
        const vm = makeVm();
        await renderPlayer(vm);
        const bar = screen.getByRole("slider", { name: "Seek" });
        fireEvent.change(bar, { target: { value: "300" } });
        expect(vm.seek).not.toHaveBeenCalled();
        fireEvent.pointerUp(bar);
        expect(vm.seek).toHaveBeenCalledWith(300);
    });

    it("changes speed from its menu", async () => {
        const vm = makeVm();
        await renderPlayer(vm);
        fireEvent.click(screen.getByRole("button", { name: "Playback speed 1×" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5×" }));
        expect(vm.setRate).toHaveBeenCalledWith(1.5);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("sets only this device's volume, and not while deafened", async () => {
        const vm = makeVm();
        await renderPlayer(vm);
        fireEvent.click(screen.getByRole("button", { name: "Mute for me" }));
        expect(vm.setVolume).toHaveBeenCalledWith(0);
    });

    it("cannot be turned up while deafened", async () => {
        await renderPlayer(makeVm({ deafened: true }));
        expect(screen.getByRole("slider", { name: "Volume for me" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Unmute for me" })).toBeDisabled();
    });

    it("takes player shortcuts while one of its controls has focus", async () => {
        const vm = makeVm();
        await renderPlayer(vm);
        const control = screen.getByRole("button", { name: "Next" });
        fireEvent.keyDown(control, { key: "k" });
        fireEvent.keyDown(control, { key: "ArrowRight" });
        fireEvent.keyDown(control, { key: "ArrowLeft" });
        fireEvent.keyDown(screen.getByRole("slider", { name: "Seek" }), { key: "ArrowRight" });
        expect(vm.togglePlaying).toHaveBeenCalledTimes(1);
        expect(vm.seek).toHaveBeenNthCalledWith(1, 88);
        expect(vm.seek).toHaveBeenNthCalledWith(2, 78);
    });

    it("lets a click anywhere toggle a media file, but leaves clicks on YouTube to the embed", async () => {
        await renderPlayer(makeVm({ embedHandlesClicks: false, playing: false }));
        expect(screen.getAllByRole("button", { name: "Play for everyone" })).toHaveLength(2);
    });

    it("leaves clicks on the YouTube embed to the embed", async () => {
        await renderPlayer(makeVm({ playing: false }));
        expect(screen.getAllByRole("button", { name: "Play for everyone" })).toHaveLength(1);
    });

    it("shows the countdown to a new item in the control bar", async () => {
        await renderPlayer(makeVm({ startingIn: 1 }));
        expect(screen.getByRole("status")).toHaveTextContent("Starting for everyone…");
    });

    it("shows what someone else did in place of the details for a moment", async () => {
        await renderPlayer(makeVm({ notice: { id: 1, text: "Bob paused" } }));
        expect(screen.getByRole("status")).toHaveTextContent("Bob paused");
        expect(screen.getByText("YouTube · Blender · added by Alice")).toBeInTheDocument();
    });

    it("offers to skip or open the source when this device cannot play an item", async () => {
        const vm = makeVm({ playerError: "Not allowed outside YouTube" });
        await renderPlayer(vm);
        expect(within(screen.getByRole("alert")).getByText("Not allowed outside YouTube")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        fireEvent.click(screen.getByRole("button", { name: "Open on YouTube" }));
        expect(vm.next).toHaveBeenCalled();
        expect(vm.openSource).toHaveBeenCalled();
    });

    it("offers a replay when the queue is finished", async () => {
        const vm = makeVm({ ended: true, playing: false });
        const { onOpenQueue } = await renderPlayer(vm);
        fireEvent.click(screen.getByRole("button", { name: "Replay" }));
        fireEvent.click(screen.getByRole("button", { name: "Add more" }));
        expect(vm.togglePlaying).toHaveBeenCalled();
        expect(onOpenQueue).toHaveBeenCalled();
    });

    it("shows artwork for audio", async () => {
        const vm = makeVm({ hasVideo: false });
        await renderPlayer(vm);
        expect(document.querySelector("img")).toHaveAttribute("src", queue[0].thumbnailUrl);
    });

    it("is a small labelled tile in the filmstrip that focuses when clicked", async () => {
        const vm = makeVm();
        const { onFocus } = await renderPlayer(vm, true);
        expect(screen.queryByRole("slider")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Show the shared player" }));
        expect(onFocus).toHaveBeenCalled();
    });
});

describe("WatchTogetherPanel", () => {
    it("starts playback for everyone from a pasted link", async () => {
        const vm = makeVm({ active: false, queue: [], draft: "https://youtu.be/aqz-KE-bpKQ" });
        render(<WatchTogetherPanel vm={vm} />);
        expect(screen.getByLabelText("Watch or listen together")).toHaveFocus();
        await userEvent.click(screen.getByRole("button", { name: "Play for everyone" }));
        expect(vm.submitDraft).toHaveBeenCalledWith("play");
    });

    it("queues by default once something is playing, or plays now", async () => {
        const vm = makeVm({ draft: "https://youtu.be/jNQXAC9IVRw" });
        render(<WatchTogetherPanel vm={vm} />);
        fireEvent.submit(screen.getByLabelText("Watch or listen together").closest("form")!);
        expect(vm.submitDraft).toHaveBeenCalledWith("queue");
        await userEvent.click(screen.getByRole("button", { name: "Play now" }));
        expect(vm.submitDraft).toHaveBeenLastCalledWith("play");
    });

    it("forwards typing and shows errors", async () => {
        const vm = makeVm({ addError: "That isn't a YouTube or media file link." });
        render(<WatchTogetherPanel vm={vm} />);
        expect(screen.getByRole("alert")).toHaveTextContent("That isn't a YouTube or media file link.");
        expect(screen.getByLabelText("Watch or listen together")).toHaveAttribute("aria-invalid", "true");
        await userEvent.type(screen.getByLabelText("Watch or listen together"), "x");
        expect(vm.setDraft).toHaveBeenCalledWith("x");
    });

    it("lists the queue, jumps to an item and removes one", async () => {
        const vm = makeVm();
        render(<WatchTogetherPanel vm={vm} />);
        const current = screen.getByRole("button", { name: /^1?\s*Big Buck Bunny/ });
        expect(current).toHaveAttribute("aria-current", "true");
        await userEvent.click(screen.getByRole("button", { name: /^2\s*Me at the zoo/ }));
        expect(vm.playItem).toHaveBeenCalledWith("i2");
        await userEvent.click(screen.getByRole("button", { name: "Remove Me at the zoo" }));
        expect(vm.removeItem).toHaveBeenCalledWith("i2");
        await userEvent.click(screen.getByRole("button", { name: "End for everyone" }));
        expect(vm.stop).toHaveBeenCalled();
    });

    it("cannot share a link outside the call", () => {
        render(<WatchTogetherPanel vm={makeVm({ connected: false, active: false, queue: [] })} />);
        expect(screen.getByLabelText("Watch or listen together")).toBeDisabled();
    });
});
