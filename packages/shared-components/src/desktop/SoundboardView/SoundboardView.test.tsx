/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { MockViewModel } from "../../core/viewmodel";
import { SoundboardView, type SoundboardViewSnapshot } from "./SoundboardView";

const sound = { id: "quack", name: "Quack", emoji: "🦆", libraryId: "space" };
function makeVm() {
    return Object.assign(
        new MockViewModel<SoundboardViewSnapshot>({
            query: "",
            libraries: [
                {
                    id: "space",
                    name: "My server",
                    avatarUrl: "https://example.org/server.png",
                    canUpload: true,
                    sounds: [sound],
                },
            ],
            suggested: [sound],
            volume: 80,
            busy: false,
            uploadLibraryId: "space",
            uploadName: "",
            uploadEmoji: "🔊",
        }),
        {
            open: vi.fn(),
            setLibrary: vi.fn(),
            setQuery: vi.fn(),
            setVolume: vi.fn(),
            play: vi.fn(),
            setUploadLibrary: vi.fn(),
            setUploadName: vi.fn(),
            setUploadEmoji: vi.fn(),
            upload: vi.fn(),
            edit: vi.fn(),
            setClipVolume: vi.fn(),
            setClipRange: vi.fn(),
            previewClip: vi.fn(),
            stopClipPreview: vi.fn(),
            cancelClip: vi.fn(),
            saveClip: vi.fn(),
            remove: vi.fn(),
        },
    );
}
describe("SoundboardView", () => {
    it("opens the searchable library directly and plays a sound", async () => {
        const vm = makeVm();
        render(<SoundboardView vm={vm} />);
        expect(vm.open).toHaveBeenCalledOnce();
        expect(screen.getByRole("searchbox")).toHaveFocus();
        expect(screen.getByRole("navigation", { name: "Sound library" })).toBeVisible();
        expect(screen.queryByRole("button", { name: "View all" })).not.toBeInTheDocument();
        expect(screen.queryByText("Suggested sounds")).not.toBeInTheDocument();
        await userEvent.click(screen.getAllByRole("button", { name: "Quack" })[0]);
        expect(vm.play).toHaveBeenCalledWith(sound);
    });
    it("uses server avatars in the rail and section heading without hiding other libraries", () => {
        const vm = makeVm();
        const snapshot = {
            ...makeVm().getSnapshot(),
            selectedLibraryId: "space",
            libraries: [
                ...makeVm().getSnapshot().libraries,
                {
                    id: "builtin",
                    name: "Aether sounds",
                    canUpload: false,
                    sounds: [{ ...sound, libraryId: "builtin", id: "horn", name: "Airhorn" }],
                },
            ],
        };
        vm.getSnapshot = () => snapshot;
        const { container } = render(<SoundboardView vm={vm} />);
        expect(container.querySelectorAll('img[src="https://example.org/server.png"]')).toHaveLength(2);
        expect(screen.getByText("Aether sounds", { selector: "p" })).toBeVisible();
        expect(screen.getByRole("searchbox")).toHaveFocus();
        expect(screen.queryByText("Show less")).not.toBeInTheDocument();
    });
    it("hides empty libraries from browsing while retaining upload destinations", async () => {
        const vm = makeVm();
        const snapshot = {
            ...vm.getSnapshot(),
            libraries: [
                ...vm.getSnapshot().libraries,
                { id: "empty", name: "Empty server", sounds: [], canUpload: true },
            ],
        };
        vm.getSnapshot = () => snapshot;
        render(<SoundboardView vm={vm} />);
        expect(screen.queryByRole("button", { name: "Empty server" })).not.toBeInTheDocument();
        expect(screen.queryByText("No sounds yet")).not.toBeInTheDocument();
        await userEvent.click(screen.getByText("Upload a sound", { selector: "p" }));
        expect(screen.getByRole("option", { name: "Empty server" })).toBeInTheDocument();
    });
    it("supports searching, private previews, removal, uploads and volume", async () => {
        const vm = makeVm();
        render(<SoundboardView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "My server" }));
        expect(vm.setLibrary).toHaveBeenCalledWith("space");
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "quack" } });
        expect(vm.setQuery).toHaveBeenCalledWith("quack");
        await userEvent.click(screen.getAllByRole("button", { name: "Preview Quack" })[0]);
        expect(vm.play).toHaveBeenCalledWith(sound, true);
        await userEvent.click(screen.getByRole("button", { name: "Edit Quack" }));
        expect(vm.edit).toHaveBeenCalledWith(sound);
        await userEvent.click(screen.getByRole("button", { name: "Remove Quack" }));
        expect(vm.remove).toHaveBeenCalledWith(sound);
        await userEvent.click(screen.getAllByText("Upload a sound")[0]);
        const file = new File(["audio"], "quack.wav", { type: "audio/wav" });
        fireEvent.change(screen.getByLabelText("Upload a sound"), { target: { files: [file] } });
        expect(vm.upload).toHaveBeenCalledWith(file);
        await userEvent.click(screen.getByTitle("Soundboard volume"));
        fireEvent.change(screen.getByRole("slider"), { target: { value: "35" } });
        expect(vm.setVolume).toHaveBeenCalledWith(35);
    });
    it("chooses an emoji with search and restores focus without closing the soundboard", async () => {
        const vm = makeVm();
        render(<SoundboardView vm={vm} />);
        await userEvent.click(screen.getByText("Upload a sound", { selector: "p" }));
        const button = screen.getByRole("button", { name: "Emoji" });
        await userEvent.click(button);
        const picker = screen.getByRole("dialog", { name: "Emoji" });
        await userEvent.type(within(picker).getByRole("textbox", { name: "Search" }), "duck");
        await userEvent.click(await within(picker).findByRole("button", { name: "🦆" }));
        expect(vm.setUploadEmoji).toHaveBeenCalledWith("🦆");
        expect(screen.queryByRole("dialog", { name: "Emoji" })).not.toBeInTheDocument();
        expect(button).toHaveFocus();
        await userEvent.click(button);
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("dialog", { name: "Emoji" })).not.toBeInTheDocument();
        expect(button).toHaveFocus();
        await userEvent.click(button);
        await userEvent.click(screen.getByLabelText("Sound name"));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Emoji" })).not.toBeInTheDocument());
        expect(screen.getByLabelText("Sound name")).toHaveFocus();
    });
});
