/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useRef } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { WatchTogetherPanel, WatchTogetherPlayer, type WatchTogetherViewSnapshot } from "./WatchTogetherView";
import { useMockedViewModel } from "../../core/viewmodel";

const actions = {
    setDraft: fn(),
    submitDraft: fn(),
    addLink: fn(),
    togglePlaying: fn(),
    seek: fn(),
    setRate: fn(),
    next: fn(),
    previous: fn(),
    playItem: fn(),
    removeItem: fn(),
    stop: fn(),
    setVolume: fn(),
    attachPlayer: fn(),
    openSource: fn(),
};

const queue = [
    {
        id: "i1",
        title: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
        subtitle: "Blender",
        thumbnailUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg",
        addedBy: "chopin",
        current: true,
    },
    {
        id: "i2",
        title: "Me at the zoo",
        subtitle: "jawed",
        thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg",
        addedBy: "Bob",
        current: false,
    },
    { id: "i3", title: "Lofi mix", subtitle: "cdn.example.org", addedBy: "Alice", current: false },
];

const base: WatchTogetherViewSnapshot = {
    connected: true,
    active: true,
    title: queue[0].title,
    subtitle: "Blender",
    addedBy: "chopin",
    thumbnailUrl: queue[0].thumbnailUrl,
    sourceName: "YouTube",
    playing: false,
    ended: false,
    startingIn: null,
    buffering: false,
    hasVideo: false,
    embedHandlesClicks: true,
    position: 83,
    duration: 634,
    rate: 1,
    rates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    hasPrevious: false,
    hasNext: true,
    queue,
    volume: 70,
    deafened: false,
    draft: "",
    adding: false,
};

function PlayerStory(snapshot: WatchTogetherViewSnapshot & { compact?: boolean }): JSX.Element {
    const vm = useMockedViewModel(snapshot, actions);
    const slotRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const width = snapshot.compact ? 200 : 800;
    return (
        <div ref={containerRef} style={{ position: "relative", width, aspectRatio: "16 / 9", background: "#111" }}>
            <div ref={slotRef} style={{ position: "absolute", inset: 0 }} />
            <WatchTogetherPlayer
                vm={vm}
                slotRef={slotRef}
                containerRef={containerRef}
                compact={!!snapshot.compact}
                onFocus={fn()}
                onOpenQueue={fn()}
            />
        </div>
    );
}

function PanelStory(snapshot: WatchTogetherViewSnapshot): JSX.Element {
    const vm = useMockedViewModel(snapshot, actions);
    return <WatchTogetherPanel vm={vm} />;
}

const meta = {
    title: "Desktop/Watch together",
    component: PlayerStory,
    args: base,
} satisfies Meta<typeof PlayerStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Paused: Story = {};
export const StartingForEveryone: Story = { args: { playing: true, startingIn: 1, position: 0 } };
export const SomeoneElsePaused: Story = { args: { notice: { id: 1, text: "Bob paused" } } };
export const CannotPlayHere: Story = {
    args: { playerError: "The owner of this video doesn't allow playing it outside YouTube." },
};
export const QueueFinished: Story = { args: { ended: true, hasNext: false } };
export const Deafened: Story = { args: { deafened: true } };
export const InFilmstrip: Story = { args: { compact: true } };

export const Panel: StoryObj<typeof PanelStory> = {
    render: (args) => <PanelStory {...args} />,
    args: { ...base, draft: "https://youtu.be/jNQXAC9IVRw" },
};
export const PanelBeforeAnything: StoryObj<typeof PanelStory> = {
    render: (args) => <PanelStory {...args} />,
    args: { ...base, active: false, queue: [] },
};
export const PanelWithError: StoryObj<typeof PanelStory> = {
    render: (args) => <PanelStory {...args} />,
    args: { ...base, draft: "hello", addError: "That isn't a YouTube or media file link." },
};
