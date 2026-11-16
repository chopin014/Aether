/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
    encodeMessage,
    isNewer,
    isValidRef,
    parseMessage,
    parseState,
    WATCH_STATE,
    WATCH_SYNC_REQUEST,
    type WatchState,
} from "./WatchTogetherProtocol";

const state = (patch: Partial<WatchState> = {}): WatchState => ({
    session: "s1",
    revision: 3,
    author: "@alice:example.org",
    origin: "o1",
    items: [{ id: "i1", source: "youtube", ref: "aqz-KE-bpKQ", title: "Bunny", addedBy: "@alice:example.org" }],
    index: 0,
    playing: true,
    position: 12.5,
    rate: 1,
    ended: false,
    ...patch,
});

describe("WatchTogetherProtocol", () => {
    it("round-trips a state and a sync request", () => {
        expect(parseMessage(encodeMessage({ type: WATCH_STATE, state: state() }))).toEqual({
            type: WATCH_STATE,
            state: state(),
        });
        expect(parseMessage(encodeMessage({ type: WATCH_SYNC_REQUEST }))).toEqual({ type: WATCH_SYNC_REQUEST });
    });

    it("ignores other call data such as soundboard plays", () => {
        const soundboard = new TextEncoder().encode(JSON.stringify({ type: "io.aether.soundboard.play", id: "x" }));
        expect(parseMessage(soundboard)).toBeUndefined();
        expect(parseMessage(new TextEncoder().encode("not json"))).toBeUndefined();
        expect(parseMessage(new TextEncoder().encode("[1]"))).toBeUndefined();
    });

    it("accepts a stopped activity, whose queue is empty", () => {
        expect(parseState(state({ items: [], index: -1, playing: false }))).toBeDefined();
    });

    it.each<[string, Partial<WatchState> | Record<string, unknown>]>([
        ["an index outside the queue", { index: 1 }],
        ["an empty queue with an index", { items: [], index: 0 }],
        ["an unsupported speed", { rate: 3 }],
        ["a position far before the start", { position: -60 }],
        ["a revision of zero", { revision: 0 }],
        ["a missing ended flag", { ended: undefined }],
        ["duplicate item IDs", { items: [state().items[0], state().items[0]] }],
        ["an http media link", { items: [{ ...state().items[0], source: "media", ref: "http://example.org/a.mp4" }] }],
        ["a malformed YouTube ID", { items: [{ ...state().items[0], ref: "../../evil" }] }],
        ["a very long title", { items: [{ ...state().items[0], title: "x".repeat(500) }] }],
    ])("rejects %s", (_, patch) => {
        expect(parseState({ ...state(), ...patch })).toBeUndefined();
    });

    it("drops unknown fields from items", () => {
        const parsed = parseState({ ...state(), items: [{ ...state().items[0], html: "<script>" }] });
        expect(parsed?.items[0]).not.toHaveProperty("html");
    });

    it("validates refs by source", () => {
        expect(isValidRef("youtube", "aqz-KE-bpKQ")).toBe(true);
        expect(isValidRef("media", "https://example.org/song.mp3")).toBe(true);
        expect(isValidRef("media", "javascript:alert(1)")).toBe(false);
        expect(isValidRef("media", "not a url")).toBe(false);
    });

    it("orders states by revision, then by origin", () => {
        expect(isNewer(state({ revision: 4 }), state())).toBe(true);
        expect(isNewer(state(), state({ revision: 4 }))).toBe(false);
        expect(isNewer(state({ origin: "o2" }), state({ origin: "o1" }))).toBe(true);
        expect(isNewer(state(), state())).toBe(false);
    });
});
