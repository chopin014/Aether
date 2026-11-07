/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopProfilePopoutView,
    type DesktopProfilePopoutViewActions,
    type DesktopProfilePopoutViewSnapshot,
} from "./DesktopProfilePopoutView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DesktopProfilePopoutViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopProfilePopoutViewSnapshot>({
            userId: "@robin:example.org",
            displayName: "Robin",
            presence: "online",
            roles: [{ key: "moderator", label: "Moderator" }],
            isMe: false,
            canMessage: true,
            canVerify: true,
            isVerified: false,
            canMention: true,
            isIgnored: false,
            canModerate: true,
            busy: false,
            error: false,
            ...snapshot,
        }),
        {
            message: vi.fn(),
            verify: vi.fn(),
            mention: vi.fn(),
            copyLink: vi.fn(),
            toggleIgnore: vi.fn(),
            moderate: vi.fn(),
            openFullProfile: vi.fn(),
            openRoom: vi.fn(),
            editProfile: vi.fn(),
            close: vi.fn(),
        } satisfies DesktopProfilePopoutViewActions,
    );
}

/** Compound's spacing scale, which the test page does not load. */
const SPACING = Object.fromEntries(
    [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => [`--cpd-space-${String(n).replace(".", "-")}x`, `${n * 4}px`]),
) as React.CSSProperties;

describe("DesktopProfilePopoutView", () => {
    it("shows the Spaces you share and the voice channel the person is in, with a way to join them", async () => {
        const vm = makeVm({
            mutual: { count: 2, faces: [{ id: "!a:example.org", name: "Aether HQ" }] },
            activity: {
                kind: "voice",
                roomId: "!voice:example.org",
                channelName: "Lounge",
                count: 3,
                people: [
                    { id: "@robin:example.org", name: "Robin" },
                    { id: "@sam:example.org", name: "Sam" },
                ],
            },
        });
        render(<DesktopProfilePopoutView vm={vm} />);
        expect(screen.getByText("2 mutual servers")).toBeVisible();
        expect(screen.getByRole("region", { name: "In voice" }).textContent).toContain("Lounge");
        expect(screen.getByText("3 people in voice")).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Join voice channel" }));
        expect(vm.openRoom).toHaveBeenCalledWith("!voice:example.org");
    });

    it("does not offer to join your own voice channel", () => {
        const activity = {
            kind: "voice" as const,
            roomId: "!v:example.org",
            channelName: "Lounge",
            count: 1,
            people: [],
        };
        render(<DesktopProfilePopoutView vm={makeVm({ isMe: true, canMessage: false, activity })} />);
        expect(screen.getByText("Lounge")).toBeVisible();
        expect(screen.queryByRole("button", { name: "Join voice channel" })).toBeNull();
    });

    it("shows do not disturb", () => {
        render(<DesktopProfilePopoutView vm={makeVm({ presence: "busy" })} />);
        expect(screen.getByRole("img", { name: "Do not disturb" })).toHaveAttribute("data-presence", "busy");
    });

    it("shows the name, Matrix ID, role chips and presence", () => {
        render(<DesktopProfilePopoutView vm={makeVm()} />);
        expect(screen.getByRole("heading", { name: "Robin" })).toBeVisible();
        expect(screen.getByText("@robin:example.org")).toBeVisible();
        expect(screen.getByRole("list", { name: "Roles" })).toHaveTextContent("Moderator");
        expect(screen.getByRole("img", { name: "Online" })).toBeInTheDocument();
    });

    it("shows the already loaded preview until the larger avatar has loaded", async () => {
        const loads: Array<() => void> = [];
        const RealImage = window.Image;
        // Each preload image reports loading when the test says so.
        vi.stubGlobal(
            "Image",
            class {
                public onload: (() => void) | null = null;
                public set src(_value: string) {
                    loads.push(() => this.onload?.());
                }
            },
        );
        try {
            render(
                <DesktopProfilePopoutView
                    vm={makeVm({ avatarUrl: "https://hs/large", avatarPreviewUrl: "https://hs/small" })}
                />,
            );
            const avatar = (): string | null | undefined =>
                document.querySelector("[class*=avatar] img, img")?.getAttribute("src");
            expect(avatar()).toBe("https://hs/small");
            await act(async () => loads.forEach((load) => load()));
            expect(avatar()).toBe("https://hs/large");
        } finally {
            vi.stubGlobal("Image", RealImage);
            vi.unstubAllGlobals();
        }
    });

    it("uses the avatar directly when there is no preview", () => {
        render(<DesktopProfilePopoutView vm={makeVm({ avatarUrl: "https://hs/large" })} />);
        expect(document.querySelector("img")?.getAttribute("src")).toBe("https://hs/large");
    });

    it("omits the presence badge and role list when neither is known", () => {
        render(<DesktopProfilePopoutView vm={makeVm({ presence: undefined, roles: [] })} />);
        expect(screen.queryByRole("img", { name: "Online" })).toBeNull();
        expect(screen.queryByRole("list", { name: "Roles" })).toBeNull();
    });

    it("sends the typed draft when Enter is pressed", async () => {
        const vm = makeVm();
        render(<DesktopProfilePopoutView vm={vm} />);
        await userEvent.type(screen.getByLabelText("Message Robin"), "hello{Enter}");
        expect(vm.message).toHaveBeenCalledWith("hello");
    });

    it("opens the full profile from the avatar and from the name", async () => {
        const vm = makeVm();
        render(<DesktopProfilePopoutView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "View full profile of Robin" }));
        await userEvent.click(screen.getByRole("button", { name: "Robin" }));
        expect(vm.openFullProfile).toHaveBeenCalledTimes(2);
    });

    it("forwards verify and the direct-message shortcut", async () => {
        const vm = makeVm();
        render(<DesktopProfilePopoutView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        await userEvent.click(screen.getByRole("button", { name: "Message" }));
        expect(vm.verify).toHaveBeenCalled();
        expect(vm.message).toHaveBeenCalledWith("");
    });

    it("lists only the more-menu actions that apply", async () => {
        const vm = makeVm({ canMention: false, canModerate: false, isIgnored: true });
        render(<DesktopProfilePopoutView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "More actions" }));
        expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
        expect(screen.getByRole("menuitem", { name: "Unignore" })).toBeVisible();
        expect(screen.queryByRole("menuitem", { name: "Mention" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Moderate in room info" })).toBeNull();
        await userEvent.click(screen.getByRole("menuitem", { name: "Unignore" }));
        expect(vm.toggleIgnore).toHaveBeenCalled();
    });

    it("places the portalled menu above a positioned profile host", async () => {
        render(
            <div style={{ position: "fixed", zIndex: 100, left: 10, top: 10 }}>
                <DesktopProfilePopoutView vm={makeVm()} />
            </div>,
        );
        await userEvent.click(screen.getByRole("button", { name: "More actions" }));
        const copy = screen.getByRole("menuitem", { name: "Copy link" });
        const rect = copy.getBoundingClientRect();
        expect(copy.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))).toBe(true);
    });

    it("copies a link without closing the card and returns focus after Escape", async () => {
        const vm = makeVm();
        render(<DesktopProfilePopoutView vm={vm} />);
        const trigger = screen.getByRole("button", { name: "More actions" });
        await userEvent.click(trigger);
        await userEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
        expect(vm.copyLink).toHaveBeenCalledOnce();
        expect(vm.close).not.toHaveBeenCalled();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        await userEvent.click(trigger);
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it("hides the message field for yourself and reports a failed open", () => {
        const { unmount } = render(<DesktopProfilePopoutView vm={makeVm({ isMe: true, canMessage: false })} />);
        expect(screen.queryByLabelText("Message Robin")).toBeNull();
        unmount();
        render(<DesktopProfilePopoutView vm={makeVm({ error: true })} />);
        expect(screen.getByRole("alert").textContent).toContain("Could not open the conversation");
    });

    it("folds a long bio behind a button that opens the full profile", async () => {
        const vm = makeVm({ bio: "word ".repeat(60) });
        render(<DesktopProfilePopoutView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "View full bio" }));
        expect(vm.openFullProfile).toHaveBeenCalled();
    });

    it("never treats a bio as markup and only links web addresses", () => {
        render(
            <DesktopProfilePopoutView
                vm={makeVm({ bio: "<img src=x onerror=alert(1)> javascript:alert(1) https://example.org/a." })}
            />,
        );
        expect(document.querySelector("img[src='x']")).toBeNull();
        expect(screen.getByText(/onerror/)).toBeVisible();
        const links = screen.getAllByRole("link");
        expect(links).toHaveLength(1);
        expect(links[0]).toHaveAttribute("href", "https://example.org/a");
        expect(links[0]).toHaveAttribute("rel", "noreferrer noopener");
    });

    it("offers editing on your own card, in place of the message field", async () => {
        const vm = makeVm({ isMe: true, canMessage: false });
        render(<DesktopProfilePopoutView vm={vm} />);
        expect(screen.queryByRole("textbox")).toBeNull();
        await userEvent.click(screen.getByRole("button", { name: "Edit profile" }));
        expect(vm.editProfile).toHaveBeenCalled();
    });

    it("draws the person's decoration, pronouns and tag", () => {
        render(
            <DesktopProfilePopoutView
                vm={makeVm({
                    pronouns: "they/them",
                    tag: { label: "ENG", spaceName: "English Server" },
                    appearance: { decoration: "orbit", theme: { primary: "#101018", accent: "#2a0a40" } },
                })}
            />,
        );
        expect(screen.getByText("they/them")).toBeVisible();
        expect(screen.getByTitle("Tag of English Server")).toHaveTextContent("ENG");
        expect(document.querySelector('[data-decoration="orbit"]')).not.toBeNull();
        expect(document.querySelector('[data-tone="dark"]')).not.toBeNull();
    });

    it("keeps the avatar ring a circle and the decoration centred on the avatar", () => {
        render(<DesktopProfilePopoutView vm={makeVm({ appearance: { decoration: "halo" } })} />);
        const decoration = document.querySelector('[data-decoration="halo"]')!;
        const box = decoration.parentElement!;
        const measure = (element: Element): DOMRect => element.getBoundingClientRect();
        expect(measure(box).width).toBe(80);
        expect(measure(box).height).toBe(80);
        expect(measure(box.parentElement!).width).toBe(measure(box.parentElement!).height);
        expect(measure(decoration).width).toBeCloseTo(measure(decoration).height, 1);
        expect(measure(decoration).top + measure(decoration).height / 2).toBeCloseTo(measure(box).top + 40, 1);
        expect(measure(decoration).left + measure(decoration).width / 2).toBeCloseTo(measure(box).left + 40, 1);
    });

    it("sets the presence dot on the edge of the avatar, as Discord does", () => {
        // The test page has none of Compound's spacing tokens, so the ones the layout uses are given here.
        render(
            <div style={SPACING}>
                <DesktopProfilePopoutView vm={makeVm()} />
            </div>,
        );
        const dot = screen.getByRole("img", { name: "Online" }).getBoundingClientRect();
        // The box that holds the avatar is exactly the avatar's size.
        const avatar = document.querySelector('[class*="avatarBox"]')!.getBoundingClientRect();
        const distance = Math.hypot(
            dot.x + dot.width / 2 - (avatar.x + avatar.width / 2),
            dot.y + dot.height / 2 - (avatar.y + avatar.height / 2),
        );
        expect(avatar.width).toBeCloseTo(80, 0);
        expect(Math.abs(distance - 80 / 2)).toBeLessThan(2);
    });
});
