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

describe("ServerVoiceActivity", () => {
    it("names each occupied voice channel and who is in it", () => {
        render(
            <ServerVoiceActivity
                channels={[
                    { roomId: "!a", name: "Lounge", people: [person("Alice"), person("Bob")] },
                    { roomId: "!b", name: "Geral#1", people: [person("Carol")] },
                ]}
            />,
        );
        expect(screen.getByText("Lounge")).toBeVisible();
        expect(screen.getByLabelText("In voice: Alice, Bob")).toBeVisible();
        expect(screen.getByText("Geral#1")).toBeVisible();
        expect(screen.getByLabelText("In voice: Carol")).toBeVisible();
    });

    it("sums up everyone past the first five faces", () => {
        const people = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace"].map(person);
        const { container } = render(<ServerVoiceActivity channels={[{ roomId: "!a", name: "Lounge", people }]} />);
        expect(container.querySelectorAll("[data-type='round']")).toHaveLength(5);
        expect(screen.getByText("+2")).toBeVisible();
        expect(screen.getByLabelText(`In voice: ${people.map((p) => p.name).join(", ")}`)).toBeVisible();
    });
});
