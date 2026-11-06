/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { IncomingCallView, type IncomingCallViewCall, type IncomingCallViewSnapshot } from "./IncomingCallView";
import { MockViewModel } from "../../core/viewmodel";

const voiceCall: IncomingCallViewCall = { id: "dm", name: "Pon", initialLetter: "P", kind: "voice" };

function show(calls: IncomingCallViewCall[]) {
    const vm = Object.assign(new MockViewModel<IncomingCallViewSnapshot>({ calls }), {
        accept: vi.fn(),
        decline: vi.fn(),
    });
    const { container } = render(<IncomingCallView vm={vm} />);
    return { vm, container };
}

describe("IncomingCallView", () => {
    it("renders nothing while no call rings", () => {
        const { container } = show([]);
        expect(container).toBeEmptyDOMElement();
    });

    it("shows who is calling and answers a voice call", async () => {
        const { vm } = show([voiceCall]);
        const card = screen.getByRole("region", { name: "Incoming call from Pon" });
        expect(within(card).getByText("Pon")).toBeVisible();
        expect(within(card).getByText("Incoming call…")).toBeVisible();
        expect(within(card).queryByRole("button", { name: "Accept with video" })).toBeNull();

        await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
        expect(vm.accept).toHaveBeenCalledWith("dm", false);
        await userEvent.click(within(card).getByRole("button", { name: "Decline" }));
        expect(vm.decline).toHaveBeenCalledWith("dm");
    });

    it("offers to answer a video call with or without the camera", async () => {
        const { vm } = show([{ ...voiceCall, kind: "video", avatarUrl: "https://example.org/pon.png" }]);
        expect(screen.getByText("Incoming video call…")).toBeVisible();
        expect(screen.getByTestId("incoming-call").querySelector("img")).toHaveAttribute(
            "src",
            "https://example.org/pon.png",
        );

        await userEvent.click(screen.getByRole("button", { name: "Accept with video" }));
        expect(vm.accept).toHaveBeenCalledWith("dm", true);
        await userEvent.click(screen.getByRole("button", { name: "Accept without video" }));
        expect(vm.accept).toHaveBeenLastCalledWith("dm", false);
    });

    it("stacks several calls and names who started a group call", () => {
        show([
            voiceCall,
            { id: "group", name: "Business Meeting", initialLetter: "B", kind: "voice", startedBy: "Ana" },
        ]);
        expect(screen.getAllByTestId("incoming-call")).toHaveLength(2);
        expect(screen.getByText("Ana started a call")).toBeVisible();
    });
});
