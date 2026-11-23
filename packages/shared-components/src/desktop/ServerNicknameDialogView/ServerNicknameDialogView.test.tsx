/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";

import { MockViewModel } from "../../core/viewmodel";
import { ServerNicknameDialogView, type ServerNicknameDialogViewSnapshot } from "./ServerNicknameDialogView";

function makeVm(snapshot: Partial<ServerNicknameDialogViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<ServerNicknameDialogViewSnapshot>({
            forSelf: false,
            personName: "hLiTz",
            nickname: "sdds do litz",
            canReset: true,
            setByModerator: false,
            busy: false,
            ...snapshot,
        }),
        { setNickname: vi.fn(), save: vi.fn(), reset: vi.fn(), cancel: vi.fn() },
    );
}

describe("ServerNicknameDialogView", () => {
    it("warns a moderator changing someone else's nickname, and saves, resets or cancels", () => {
        const vm = makeVm();
        render(<ServerNicknameDialogView vm={vm} />);
        expect(screen.getByRole("heading", { name: "Change nickname" })).toBeVisible();
        expect(screen.getByText(/Nicknames are visible to everyone in this server/)).toBeVisible();
        const field = screen.getByRole("textbox", { name: "Nickname" });
        expect(field).toHaveValue("sdds do litz");
        expect(field).toHaveAttribute("placeholder", "hLiTz");
        expect(field).toHaveAttribute("maxLength", "32");

        fireEvent.change(field, { target: { value: "litz" } });
        expect(vm.setNickname).toHaveBeenCalledWith("litz");
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(vm.save).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Reset nickname" }));
        expect(vm.reset).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(vm.cancel).toHaveBeenCalledOnce();
    });

    it("leaves the warning out for the user's own nickname, and says when a moderator's applies", () => {
        const { rerender } = render(
            <ServerNicknameDialogView vm={makeVm({ forSelf: true, nickname: "", canReset: false })} />,
        );
        expect(screen.queryByText(/Nicknames are visible to everyone/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Reset nickname" })).toBeNull();
        rerender(<ServerNicknameDialogView vm={makeVm({ forSelf: true, setByModerator: true })} />);
        expect(screen.getByText(/A moderator set your nickname in this server/)).toBeVisible();
    });

    it("saves with Enter, and shows why saving failed", () => {
        const vm = makeVm({ error: "Forbidden" });
        render(<ServerNicknameDialogView vm={vm} />);
        expect(screen.getByRole("alert")).toHaveTextContent("Forbidden");
        fireEvent.submit(screen.getByRole("textbox", { name: "Nickname" }).closest("form")!);
        expect(vm.save).toHaveBeenCalledOnce();
    });

    it("locks the controls while saving", () => {
        render(<ServerNicknameDialogView vm={makeVm({ busy: true })} />);
        expect(screen.getByRole("textbox", { name: "Nickname" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
});
