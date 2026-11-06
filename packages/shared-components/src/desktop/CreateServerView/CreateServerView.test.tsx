/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { CreateServerView, type CreateServerViewSnapshot } from "./CreateServerView";
import { MockViewModel } from "../../core/viewmodel";

function renderFlow(snapshot: Partial<CreateServerViewSnapshot> = {}) {
    const vm = Object.assign(
        new MockViewModel<CreateServerViewSnapshot>({
            step: "start",
            canChooseAudience: true,
            canExplore: true,
            audience: "friends",
            name: "Alice's server",
            joinAddress: "",
            busy: false,
            ...snapshot,
        }),
        {
            startCreate: vi.fn(),
            startJoin: vi.fn(),
            chooseAudience: vi.fn(),
            back: vi.fn(),
            setName: vi.fn(),
            setAvatar: vi.fn(),
            create: vi.fn(),
            setJoinAddress: vi.fn(),
            join: vi.fn(),
            explore: vi.fn(),
        },
    );
    render(<CreateServerView vm={vm} />);
    return vm;
}

describe("CreateServerView", () => {
    it("offers to create, join or explore on the first screen", async () => {
        const vm = renderFlow();
        expect(screen.getByRole("heading", { name: "Create your server" })).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: /Create my own/ }));
        expect(vm.startCreate).toHaveBeenCalled();
        await userEvent.click(screen.getByRole("button", { name: "Join a server" }));
        expect(vm.startJoin).toHaveBeenCalled();
        await userEvent.click(screen.getByRole("button", { name: "Explore public servers" }));
        expect(vm.explore).toHaveBeenCalled();
    });

    it("hides Explore when the homeserver cannot list public servers", () => {
        renderFlow({ canExplore: false });
        expect(screen.queryByRole("button", { name: "Explore public servers" })).not.toBeInTheDocument();
    });

    it("asks who the server is for, with a way to skip", async () => {
        const vm = renderFlow({ step: "audience" });
        await userEvent.click(screen.getByRole("button", { name: /For a club or community/ }));
        expect(vm.chooseAudience).toHaveBeenCalledWith("community");
        await userEvent.click(screen.getByRole("button", { name: "skip this question" }));
        expect(vm.chooseAudience).toHaveBeenLastCalledWith("friends");
        await userEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(vm.back).toHaveBeenCalled();
    });

    it("names the server, picks an icon and creates it", async () => {
        const vm = renderFlow({ step: "customise" });
        expect(screen.getByRole("heading", { name: "Customise your server" })).toBeVisible();
        const name = screen.getByRole("textbox", { name: /Server name/ });
        expect(name).toHaveValue("Alice's server");
        await userEvent.type(name, "!");
        expect(vm.setName).toHaveBeenCalledWith("Alice's server!");

        const file = new File(["icon"], "icon.png", { type: "image/png" });
        await userEvent.upload(screen.getByTestId("server-icon-input"), file);
        expect(vm.setAvatar).toHaveBeenCalledWith(file);

        await userEvent.click(screen.getByRole("button", { name: "Create" }));
        expect(vm.create).toHaveBeenCalled();
    });

    it("shows the chosen icon, progress and errors", () => {
        renderFlow({
            step: "customise",
            avatarUrl: "blob:icon",
            busy: true,
            progress: "Setting up channels…",
            error: "Could not create",
        });
        expect(screen.getByRole("button", { name: "Upload server icon" }).querySelector("img")).toHaveAttribute(
            "src",
            "blob:icon",
        );
        expect(screen.getByRole("status")).toHaveTextContent("Setting up channels…");
        expect(screen.getByRole("alert")).toHaveTextContent("Could not create");
        expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    });

    it("joins with a typed invite", async () => {
        const vm = renderFlow({ step: "join", joinAddress: "#aether:matrix.org", error: "Bad invite" });
        expect(screen.getByRole("alert")).toHaveTextContent("Bad invite");
        await userEvent.type(screen.getByRole("textbox", { name: /Invite link/ }), "x");
        expect(vm.setJoinAddress).toHaveBeenCalledWith("#aether:matrix.orgx");
        await userEvent.click(screen.getByRole("button", { name: "Join a server" }));
        expect(vm.join).toHaveBeenCalled();
    });
});
