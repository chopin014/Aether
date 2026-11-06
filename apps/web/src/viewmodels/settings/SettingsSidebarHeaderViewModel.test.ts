/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { SettingsSidebarHeaderViewModel } from "./SettingsSidebarHeaderViewModel";
import { type OwnProfileStore } from "../../stores/OwnProfileStore";
import { UPDATE_EVENT } from "../../stores/AsyncStore";

function fakeProfileStore(displayName: string | null): OwnProfileStore & { displayName: string | null } {
    return Object.assign(new TypedEventEmitter<string, any>(), {
        displayName,
        getHttpAvatarUrl: vi.fn().mockReturnValue("https://example.org/avatar.png"),
    }) as any;
}

describe("SettingsSidebarHeaderViewModel", () => {
    const create = (store = fakeProfileStore("chopin")) => {
        const props = {
            client: stubClient(),
            ownProfileStore: store,
            onQueryChange: vi.fn(),
            onOpenFirstMatch: vi.fn(),
            onEditProfile: vi.fn(),
        };
        return { vm: new SettingsSidebarHeaderViewModel(props), props, store };
    };

    it("shows the user's name and picture, falling back to their ID", () => {
        expect(create().vm.getSnapshot()).toMatchObject({
            displayName: "chopin",
            avatarUrl: "https://example.org/avatar.png",
            query: "",
        });
        const { vm, props } = create(fakeProfileStore(null));
        expect(vm.getSnapshot().displayName).toBe(props.client.getSafeUserId());
    });

    it("follows profile changes", () => {
        const { vm, store } = create();
        store.displayName = "Frédéric";
        store.emit(UPDATE_EVENT);
        expect(vm.getSnapshot().displayName).toBe("Frédéric");
        vm.dispose();
    });

    it("passes the search on and keeps it in the field", () => {
        const { vm, props } = create();
        vm.setQuery("senha");
        expect(vm.getSnapshot().query).toBe("senha");
        expect(props.onQueryChange).toHaveBeenCalledWith("senha");
    });

    it("opens the first match and the profile editor", () => {
        const { vm, props } = create();
        vm.openFirstMatch();
        vm.editProfile();
        expect(props.onOpenFirstMatch).toHaveBeenCalled();
        expect(props.onEditProfile).toHaveBeenCalled();
    });
});
