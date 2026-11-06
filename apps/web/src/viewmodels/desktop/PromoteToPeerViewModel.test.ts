/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import { normalisePhrase, PromoteToPeerViewModel } from "./PromoteToPeerViewModel";

function makeRoom({ isSpace = false, names = {} as Record<string, string> } = {}): Room {
    return {
        name: "Gamers",
        isSpaceRoom: () => isSpace,
        getMember: (userId: string) =>
            names[userId] ? ({ rawDisplayName: names[userId] } as unknown as RoomMember) : null,
    } as unknown as Room;
}

describe("normalisePhrase", () => {
    it("ignores case, accents, spacing and a closing full stop", () => {
        expect(normalisePhrase("  Quero dar a  JOÃO o mesmo poder que eu. ")).toBe(
            normalisePhrase("quero dar a joao o mesmo poder que eu"),
        );
    });

    it("still tells different words apart", () => {
        expect(normalisePhrase("I want to make Bob as powerful as me")).not.toBe(
            normalisePhrase("I want to make Bo as powerful as me"),
        );
    });
});

describe("PromoteToPeerViewModel", () => {
    it("names one person and asks for a sentence with their name", () => {
        const vm = new PromoteToPeerViewModel({
            room: makeRoom({ isSpace: true, names: { "@bob:example.org": "Bob" } }),
            userIds: ["@bob:example.org"],
            onFinished: vi.fn(),
        });
        expect(vm.getSnapshot()).toEqual({
            target: { name: "Bob" },
            roomName: "Gamers",
            isServer: true,
            phrase: "I want to make Bob as powerful as me",
            typed: "",
            matches: false,
        });
    });

    it("falls back to the user ID, and counts several people", () => {
        const one = new PromoteToPeerViewModel({ room: makeRoom(), userIds: ["@bob:x"], onFinished: vi.fn() });
        expect(one.getSnapshot().target).toEqual({ name: "@bob:x" });

        const many = new PromoteToPeerViewModel({ room: makeRoom(), userIds: ["@a:x", "@b:x"], onFinished: vi.fn() });
        expect(many.getSnapshot()).toMatchObject({
            target: { count: 2 },
            isServer: false,
            phrase: "I want to make these 2 people as powerful as me",
        });
    });

    it("confirms only once the typed sentence matches", () => {
        const onFinished = vi.fn();
        const vm = new PromoteToPeerViewModel({
            room: makeRoom({ names: { "@bob:x": "Bob" } }),
            userIds: ["@bob:x"],
            onFinished,
        });

        vm.setTyped("I want to make Bob");
        expect(vm.getSnapshot()).toMatchObject({ typed: "I want to make Bob", matches: false });
        vm.confirm();
        expect(onFinished).not.toHaveBeenCalled();

        vm.setTyped("i want to make bob as powerful as me.");
        expect(vm.getSnapshot().matches).toBe(true);
        vm.confirm();
        expect(onFinished).toHaveBeenCalledWith(true);
    });

    it("cancels", () => {
        const onFinished = vi.fn();
        const vm = new PromoteToPeerViewModel({ room: makeRoom(), userIds: ["@bob:x"], onFinished });
        vm.cancel();
        expect(onFinished).toHaveBeenCalledWith(false);
    });
});
