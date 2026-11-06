/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@test-utils";

import { ServerVoiceActivity } from "./ServerVoiceActivity";

const person = (name: string) => ({ userId: `@${name.toLowerCase()}:example.org`, name });
const server = { id: "!terra:example.org", name: "Terra do boi gordo" };

describe("ServerVoiceActivity", () => {
    it("shows the server and the faces of everyone in its voice channels", () => {
        const { container } = render(
            <ServerVoiceActivity
                server={server}
                channels={[
                    { roomId: "!a", name: "Lounge", people: [person("Alice"), person("Bob")] },
                    { roomId: "!b", name: "Geral#1", people: [person("Carol")] },
                ]}
            />,
        );
        expect(screen.getByText("Terra do boi gordo")).toBeVisible();
        expect(screen.getByLabelText("In voice: Lounge: Alice, Bob; Geral#1: Carol")).toBeVisible();
        expect(container.querySelectorAll("[data-type='round']")).toHaveLength(3);
        expect(container.querySelector("[data-server-hover-card]")).not.toBeNull();
    });

    it("shows someone in two channels once", () => {
        const { container } = render(
            <ServerVoiceActivity
                server={server}
                channels={[
                    { roomId: "!a", name: "Lounge", people: [person("Alice")] },
                    { roomId: "!b", name: "Geral#1", people: [person("Alice"), person("Bob")] },
                ]}
            />,
        );
        expect(container.querySelectorAll("[data-type='round']")).toHaveLength(2);
    });

    it("sums up everyone past the first five faces", () => {
        const people = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace"].map(person);
        const { container } = render(
            <ServerVoiceActivity server={server} channels={[{ roomId: "!a", name: "Lounge", people }]} />,
        );
        expect(container.querySelectorAll("[data-type='round']")).toHaveLength(5);
        expect(screen.getByText("+2")).toBeVisible();
    });
});
