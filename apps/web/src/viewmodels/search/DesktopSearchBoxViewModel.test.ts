/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { DesktopSearchBoxViewModel, type DesktopSearchScopeProvider } from "./DesktopSearchBoxViewModel";
import { DesktopMessageSearchStore } from "../../stores/DesktopMessageSearchStore";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() {
            return data.size;
        },
        clear: () => data.clear(),
        getItem: (key) => data.get(key) ?? null,
        key: (index) => [...data.keys()][index] ?? null,
        removeItem: (key) => void data.delete(key),
        setItem: (key, value) => void data.set(key, value),
    };
}

const member = (userId: string, name: string) => ({ userId, name });
const room = (roomId: string, name: string, members: ReturnType<typeof member>[] = [], space = false) =>
    ({ roomId, name, getJoinedMembers: () => members, isSpaceRoom: () => space }) as unknown as Room;

const general = room("!gen:x", "general", [member("@alice:x", "Alice"), member("@bob:x", "Bob")]);
const dev = room("!dev:x", "dev");
const dm = room("!dm:x", "Carol", [member("@carol:x", "Carol")]);
const space = room("!space:x", "Guizika", [member("@dave:x", "Dave")], true);

function makeClient(): MatrixClient {
    const rooms = [general, dev, dm, space];
    return {
        getSafeUserId: () => "@me:x",
        getRoom: (id: string) => rooms.find((candidate) => candidate.roomId === id) ?? null,
    } as unknown as MatrixClient;
}

function setup(options: { inSpace?: boolean; current?: Room } = {}) {
    const { inSpace = true, current = general } = options;
    const listeners = new Set<() => void>();
    const scope: DesktopSearchScopeProvider = {
        get: () => ({
            space: inSpace
                ? { roomId: "!space:x", name: "Guizika", roomIds: new Set(["!gen:x", "!dev:x"]) }
                : undefined,
        }),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const store = new DesktopMessageSearchStore();
    const storage = memoryStorage();
    const vm = new DesktopSearchBoxViewModel({ client: makeClient(), room: current, store, scope, storage });
    return { vm, store, storage, listeners };
}

const optionIds = (vm: DesktopSearchBoxViewModel): string[] =>
    vm.getSnapshot().sections.flatMap((section) => section.options.map((option) => option.id));

describe("DesktopSearchBoxViewModel", () => {
    let vms: DesktopSearchBoxViewModel[] = [];
    const track = <T extends { vm: DesktopSearchBoxViewModel }>(value: T): T => {
        vms.push(value.vm);
        return value;
    };
    beforeEach(() => {
        vms = [];
    });
    afterEach(() => vms.forEach((vm) => vm.dispose()));

    it("names the space when searching a space, and the room otherwise", () => {
        expect(track(setup()).vm.getSnapshot().scopeName).toBe("Guizika");
        expect(track(setup({ inSpace: false })).vm.getSnapshot().scopeName).toBe("general");
        // A DM outside the space is searched by itself.
        expect(track(setup({ current: dm })).vm.getSnapshot().scopeName).toBe("Carol");
    });

    it("follows space changes", () => {
        const { vm, listeners } = track(setup());
        expect(listeners.size).toBe(1);
        listeners.forEach((listener) => listener());
        expect(vm.getSnapshot().scopeName).toBe("Guizika");
    });

    it("offers the Discord filters when opened, then the second page on More filters", () => {
        const { vm } = track(setup());
        vm.setOpen(true);
        expect(vm.getSnapshot().open).toBe(true);
        expect(optionIds(vm)).toEqual(["filter:from", "filter:in", "filter:has", "filter:mentions", "filter:more"]);
        vm.activate("filter:more");
        expect(optionIds(vm)).toEqual([
            "filter:before",
            "filter:after",
            "filter:during",
            "filter:pinned",
            "filter:bot",
        ]);
        expect(vm.getSnapshot().sections[0].id).toBe("more");
    });

    it("writes the key into the text when a filter is chosen, then lists members", () => {
        const { vm } = track(setup());
        vm.setOpen(true);
        vm.activate("filter:from");
        expect(vm.getSnapshot().text).toBe("from:");
        expect(optionIds(vm)).toEqual(["from:@alice:x", "from:@bob:x", "from:@dave:x"]);
        vm.setText("from:ali");
        expect(optionIds(vm)).toEqual(["from:@alice:x"]);
    });

    it("turns a chosen member into a chip and runs the search in the whole space", () => {
        const { vm, store } = track(setup());
        vm.setText("from:ali");
        vm.activate("from:@alice:x");
        const snapshot = vm.getSnapshot();
        expect(snapshot.chips).toEqual([{ id: "from:@alice:x", filter: "from", value: "Alice" }]);
        expect(snapshot.text).toBe("");
        expect(snapshot.open).toBe(false);
        expect(store.active).toMatchObject({
            query: { text: "", filters: [{ key: "from", value: "@alice:x", label: "Alice" }] },
            scope: { kind: "space", roomIds: ["!gen:x", "!dev:x"] },
        });
    });

    it("narrows to a channel with in:", () => {
        const { vm, store } = track(setup());
        vm.setText("in:");
        expect(optionIds(vm)).toEqual(["in:!gen:x", "in:!dev:x"]);
        vm.setText("in:de");
        expect(optionIds(vm)).toEqual(["in:!dev:x"]);
        vm.activate("in:!dev:x");
        expect(vm.getSnapshot().chips[0].value).toBe("dev");
        expect(store.active!.scope.roomIds).toEqual(["!dev:x"]);
    });

    it("searches only the room for a DM", () => {
        const { vm, store } = track(setup({ current: dm }));
        vm.setText("hello");
        vm.submit();
        expect(store.active).toMatchObject({ scope: { kind: "room", roomIds: ["!dm:x"] }, query: { text: "hello" } });
    });

    it("completes has: values", () => {
        const { vm } = track(setup());
        vm.setText("has:");
        expect(optionIds(vm)).toEqual(["has:link", "has:file", "has:image", "has:video", "has:sound"]);
        vm.setText("has:vi");
        expect(optionIds(vm)).toEqual(["has:video"]);
        vm.activate("has:video");
        expect(vm.getSnapshot().chips[0]).toMatchObject({ filter: "has", value: "video" });
    });

    it("suggests dates, accepts a typed ISO date and hints at the format otherwise", () => {
        const { vm, store } = track(setup());
        vm.setText("before:");
        const options = vm.getSnapshot().sections[0].options;
        expect(options.map((option) => option.kind)).toEqual(["choice", "choice", "hint"]);
        vm.setText("before:2026-03-28");
        expect(optionIds(vm)).toEqual(["before:2026-03-28"]);
        vm.activate("before:2026-03-28");
        expect(store.active!.query.filters).toEqual([{ key: "before", value: "2026-03-28", label: undefined }]);
    });

    it("offers true or false for pinned and bot", () => {
        const { vm } = track(setup());
        vm.setText("pinned:");
        expect(optionIds(vm)).toEqual(["pinned:true", "pinned:false"]);
        vm.setText("bot:t");
        expect(optionIds(vm)).toEqual(["bot:true"]);
    });

    it("keeps a single value for single-valued filters", () => {
        const { vm } = track(setup());
        vm.setText("pinned:");
        vm.activate("pinned:true");
        vm.setText("pinned:");
        vm.activate("pinned:false");
        expect(vm.getSnapshot().chips.map((chip) => chip.id)).toEqual(["pinned:false"]);
    });

    it("moves through the options with the arrow keys, wrapping, and activates the highlighted one on submit", () => {
        const { vm } = track(setup());
        vm.setOpen(true);
        vm.moveActive("next");
        expect(vm.getSnapshot().activeId).toBe("filter:from");
        vm.moveActive("previous");
        expect(vm.getSnapshot().activeId).toBe("filter:more");
        vm.moveActive("next");
        expect(vm.getSnapshot().activeId).toBe("filter:from");
        vm.submit();
        expect(vm.getSnapshot().text).toBe("from:");
        expect(vm.getSnapshot().activeId).toBeNull();
    });

    it("runs the typed text on submit and resolves typed names to filters", () => {
        const { vm, store } = track(setup());
        vm.setText("from:Alice in:dev budget");
        vm.submit();
        expect(vm.getSnapshot().text).toBe("budget");
        expect(store.active).toMatchObject({
            query: {
                text: "budget",
                filters: [
                    { key: "from", value: "@alice:x" },
                    { key: "in", value: "!dev:x" },
                ],
            },
            scope: { roomIds: ["!dev:x"] },
        });
    });

    it("ignores an empty submit", () => {
        const { vm, store } = track(setup());
        vm.submit();
        expect(store.active).toBeNull();
    });

    describe("chips", () => {
        it("removes the last chip, keeping results in step, and closes them when nothing is left", () => {
            const { vm, store } = track(setup());
            vm.setText("has:file budget");
            vm.submit();
            vm.setText("");
            vm.setText("pinned:");
            vm.activate("pinned:true");
            expect(store.active!.query.filters).toHaveLength(2);

            vm.removeLastChip();
            expect(store.active!.query.filters).toEqual([{ key: "has", value: "file" }]);
            vm.removeChip("has:file");
            expect(store.active).toBeNull();
            expect(vm.getSnapshot().chips).toEqual([]);
        });
    });

    describe("escape and clear", () => {
        it("closes the popover first, then the results", () => {
            const { vm, store } = track(setup());
            vm.setText("budget");
            vm.submit();
            vm.setOpen(true);
            vm.dismiss();
            expect(vm.getSnapshot().open).toBe(false);
            expect(store.active).not.toBeNull();
            vm.dismiss();
            expect(store.active).toBeNull();
            expect(vm.getSnapshot().text).toBe("");
        });

        it("clears the box and closes the results", () => {
            const { vm, store } = track(setup());
            vm.setText("has:file");
            vm.submit();
            vm.clear();
            expect(store.active).toBeNull();
            expect(vm.getSnapshot()).toMatchObject({ text: "", chips: [] });
        });

        it("empties itself when the results are closed from their own button", () => {
            const { vm, store } = track(setup());
            vm.setText("budget");
            vm.submit();
            store.close();
            expect(vm.getSnapshot().text).toBe("");
        });
    });

    describe("recent searches", () => {
        it("records submitted searches per account and offers them", () => {
            const { vm, storage } = track(setup());
            vm.setText("budget");
            vm.submit();
            vm.setText("has:image");
            vm.submit();
            vm.setOpen(true);
            const recent = vm.getSnapshot().sections.find((section) => section.id === "recent")!;
            expect(recent.clearable).toBe(true);
            expect(recent.options.map((option) => option.id)).toEqual(["recent:0", "recent:1"]);
            expect(storage.getItem("mx_desktop_search_recents_@me:x")).toContain("budget");
        });

        it("reruns a recent search when chosen", () => {
            const { vm, store } = track(setup());
            vm.setText("budget");
            vm.submit();
            vm.setText("has:image");
            vm.submit();
            store.close();
            vm.setOpen(true);
            vm.activate("recent:1");
            expect(store.active!.query).toMatchObject({ text: "budget", filters: [] });
        });

        it("clears them", () => {
            const { vm, storage } = track(setup());
            vm.setText("budget");
            vm.submit();
            vm.setOpen(true);
            vm.clearSection("recent");
            expect(vm.getSnapshot().sections.some((section) => section.id === "recent")).toBe(false);
            expect(storage.getItem("mx_desktop_search_recents_@me:x")).toBeNull();
        });
    });

    describe("FocusMessageSearch", () => {
        it("focuses the input and opens the filters", () => {
            const { vm } = track(setup());
            const before = vm.getSnapshot().focusRequest;
            defaultDispatcher.dispatch({ action: Action.FocusMessageSearch }, true);
            expect(vm.getSnapshot().focusRequest).toBe(before + 1);
            expect(vm.getSnapshot().open).toBe(true);
        });

        it("opens with has:file applied and runs immediately, as the channel menu's Files action expects", () => {
            const { vm, store } = track(setup());
            defaultDispatcher.dispatch({ action: Action.FocusMessageSearch, initialText: "has:file" }, true);
            expect(vm.getSnapshot().chips).toEqual([{ id: "has:file", filter: "has", value: "file" }]);
            expect(vm.getSnapshot().open).toBe(false);
            expect(store.active).toMatchObject({
                query: { text: "", filters: [{ key: "has", value: "file" }] },
                scope: { kind: "space", roomIds: ["!gen:x", "!dev:x"] },
            });
        });

        it("runs a plain initial text from the spotlight", () => {
            const { vm, store } = track(setup());
            defaultDispatcher.dispatch({ action: Action.FocusMessageSearch, initialText: "release notes" }, true);
            expect(store.active!.query.text).toBe("release notes");
            expect(vm.getSnapshot().text).toBe("release notes");
        });

        it("stops listening once disposed", () => {
            const { vm } = setup();
            vm.dispose();
            const before = vm.getSnapshot().focusRequest;
            defaultDispatcher.dispatch({ action: Action.FocusMessageSearch }, true);
            expect(vm.getSnapshot().focusRequest).toBe(before);
        });
    });

    it("picks up a search already running when a new box is created", () => {
        const first = track(setup());
        first.vm.setText("has:file budget");
        first.vm.submit();
        const second = new DesktopSearchBoxViewModel({
            client: makeClient(),
            room: dev,
            store: first.store,
            scope: { get: () => ({}), subscribe: () => () => {} },
            storage: first.storage,
        });
        vms.push(second);
        expect(second.getSnapshot()).toMatchObject({ text: "budget", chips: [{ filter: "has", value: "file" }] });
    });
});
