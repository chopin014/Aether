/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import { PromoteToPeerDialog } from "./PromoteToPeerDialog";

describe("PromoteToPeerDialog", () => {
    const room = {
        name: "Gamers",
        isSpaceRoom: () => true,
        getMember: () => ({ rawDisplayName: "Bob" }) as RoomMember,
    } as unknown as Room;

    it("confirms once the sentence is typed", async () => {
        const onFinished = vi.fn();
        render(<PromoteToPeerDialog room={room} userIds={["@bob:x"]} onFinished={onFinished} />);
        expect(screen.getByRole("heading", { name: "Give the same power as you?" })).toBeVisible();

        const confirm = screen.getByRole("button", { name: "Give the same power" });
        expect(confirm).toHaveAttribute("aria-disabled", "true");
        await userEvent.type(screen.getByRole("textbox"), "I want to make Bob as powerful as me");
        expect(confirm).not.toHaveAttribute("aria-disabled", "true");
        await userEvent.click(confirm);
        expect(onFinished).toHaveBeenCalledWith(true);
    });

    it("reports a cancel", async () => {
        const onFinished = vi.fn();
        render(<PromoteToPeerDialog room={room} userIds={["@bob:x"]} onFinished={onFinished} />);
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onFinished).toHaveBeenCalledWith(false);
    });
});
