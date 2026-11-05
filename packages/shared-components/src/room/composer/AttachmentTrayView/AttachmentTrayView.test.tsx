/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";

import { MockViewModel } from "../../../core/viewmodel";
import {
    AttachmentTrayView,
    type AttachmentTrayViewActions,
    type AttachmentTrayViewSnapshot,
    type PendingAttachment,
} from "./AttachmentTrayView";

class TestAttachmentTrayViewModel extends MockViewModel<AttachmentTrayViewSnapshot> {
    public removeAttachment = vi.fn<AttachmentTrayViewActions["removeAttachment"]>();
}

const photo: PendingAttachment = { id: "a", name: "photo.png", size: 2048, kind: "image", previewUrl: "blob:photo" };
const notes: PendingAttachment = { id: "b", name: "notes.txt", size: 12, kind: "file" };

describe("AttachmentTrayView", () => {
    it("shows nothing while the tray is empty", () => {
        const { container } = render(<AttachmentTrayView vm={new TestAttachmentTrayViewModel({ attachments: [] })} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("lists each waiting file with a preview, its name and size", () => {
        render(<AttachmentTrayView vm={new TestAttachmentTrayViewModel({ attachments: [photo, notes] })} />);

        const tray = screen.getByRole("list", { name: "2 files to send" });
        expect(tray.querySelectorAll("li")).toHaveLength(2);
        expect(tray.querySelector("img")).toHaveAttribute("src", "blob:photo");
        expect(screen.getByText("photo.png")).toBeInTheDocument();
        expect(screen.getByText("notes.txt")).toBeInTheDocument();
        expect(screen.getByText("2 KB")).toBeInTheDocument();
    });

    it("takes a file out when its remove button is pressed", () => {
        const vm = new TestAttachmentTrayViewModel({ attachments: [photo, notes] });
        render(<AttachmentTrayView vm={vm} />);

        fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));

        expect(vm.removeAttachment).toHaveBeenCalledWith("b");
    });
});
