/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { parseQuery } from "./query";
import {
    clientSideKeys,
    dateBounds,
    isApproximate,
    matchesFilters,
    toRoomEventFilter,
    type FilterContext,
    type SearchableEvent,
} from "./filters";

const filters = (input: string) => parseQuery(input).filters;
const day = (iso: string, hour = 12): number => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, hour).getTime();
};

function event(content: Record<string, unknown>, extra: Partial<Record<"room" | "sender" | "ts" | "id", any>> = {}) {
    return {
        getId: () => extra.id ?? "$e",
        getRoomId: () => extra.room ?? "!a:x",
        getSender: () => extra.sender ?? "@alice:x",
        getTs: () => extra.ts ?? day("2026-03-28"),
        getContent: () => content,
    } satisfies SearchableEvent;
}

const noPins: FilterContext = { isPinned: () => false };
const text = (body: string) => ({ msgtype: "m.text", body });

describe("toRoomEventFilter", () => {
    it("sends rooms and senders to the server", () => {
        expect(toRoomEventFilter(filters("from:@a:x from:@b:x"), ["!a:x", "!b:x"])).toEqual({
            rooms: ["!a:x", "!b:x"],
            senders: ["@a:x", "@b:x"],
        });
    });

    it("maps attachment kinds of has: to contains_url", () => {
        for (const kind of ["file", "image", "video", "sound"]) {
            expect(toRoomEventFilter(filters(`has:${kind}`), ["!a:x"]).contains_url).toBe(true);
        }
    });

    it("does not map has:link to contains_url, because that key means an attachment URL", () => {
        expect(toRoomEventFilter(filters("has:link"), ["!a:x"]).contains_url).toBeUndefined();
    });

    it("leaves client-side filters out of the request", () => {
        const sent = toRoomEventFilter(filters("mentions:@a:x before:2026-01-01 pinned:true bot:false"), ["!a:x"]);
        expect(sent).toEqual({ rooms: ["!a:x"] });
    });
});

describe("clientSideKeys", () => {
    it("lists only what the server cannot apply", () => {
        expect(clientSideKeys(filters("from:@a:x in:!a:x"))).toEqual([]);
        expect(clientSideKeys(filters("has:file has:link pinned:true during:2026-03-28")).sort()).toEqual(
            ["during", "has", "pinned"].sort(),
        );
        expect(isApproximate(filters("from:@a:x"))).toBe(false);
        expect(isApproximate(filters("mentions:@a:x"))).toBe(true);
    });
});

describe("matchesFilters", () => {
    it("matches everything when there are no filters", () => {
        expect(matchesFilters(event(text("hi")), [], undefined, noPins)).toBe(true);
    });

    it("keeps events inside the scope rooms only", () => {
        const ev = event(text("hi"), { room: "!b:x" });
        expect(matchesFilters(ev, [], ["!a:x"], noPins)).toBe(false);
        expect(matchesFilters(ev, [], ["!a:x", "!b:x"], noPins)).toBe(true);
    });

    it("checks senders, for results that bypassed the server filter", () => {
        const f = filters("from:@bob:x");
        expect(matchesFilters(event(text("x"), { sender: "@bob:x" }), f, undefined, noPins)).toBe(true);
        expect(matchesFilters(event(text("x")), f, undefined, noPins)).toBe(false);
    });

    describe("has:", () => {
        it("file accepts any attachment but not text", () => {
            const f = filters("has:file");
            for (const msgtype of ["m.file", "m.image", "m.video", "m.audio"]) {
                expect(matchesFilters(event({ msgtype, body: "x" }), f, undefined, noPins)).toBe(true);
            }
            expect(matchesFilters(event(text("see file")), f, undefined, noPins)).toBe(false);
        });

        it.each([
            ["image", "m.image"],
            ["video", "m.video"],
            ["sound", "m.audio"],
        ])("%s only accepts %s", (kind, msgtype) => {
            const f = filters(`has:${kind}`);
            expect(matchesFilters(event({ msgtype, body: "x" }), f, undefined, noPins)).toBe(true);
            expect(matchesFilters(event({ msgtype: "m.file", body: "x" }), f, undefined, noPins)).toBe(false);
        });

        it("link finds URLs in the body or in formatted links", () => {
            const f = filters("has:link");
            expect(matchesFilters(event(text("see https://example.org/a?b=1 now")), f, undefined, noPins)).toBe(true);
            expect(matchesFilters(event(text("www.example.org")), f, undefined, noPins)).toBe(true);
            expect(
                matchesFilters(
                    event({ ...text("here"), formatted_body: '<a href="https://x.y">here</a>' }),
                    f,
                    undefined,
                    noPins,
                ),
            ).toBe(true);
            expect(matchesFilters(event(text("no links here")), f, undefined, noPins)).toBe(false);
        });

        it("requires every has: filter", () => {
            const f = filters("has:image has:link");
            expect(matchesFilters(event({ msgtype: "m.image", body: "x" }), f, undefined, noPins)).toBe(false);
            expect(matchesFilters(event({ msgtype: "m.image", body: "https://a.b/x.png" }), f, undefined, noPins)).toBe(
                true,
            );
        });
    });

    describe("mentions:", () => {
        const f = filters("mentions:@eve:y");

        it("uses m.mentions", () => {
            const ev = event({ ...text("hello"), "m.mentions": { user_ids: ["@eve:y"] } });
            expect(matchesFilters(ev, f, undefined, noPins)).toBe(true);
        });

        it("falls back to pills and plain IDs", () => {
            expect(
                matchesFilters(
                    event({ ...text("Eve"), formatted_body: '<a href="https://matrix.to/#/@eve:y">Eve</a>' }),
                    f,
                    undefined,
                    noPins,
                ),
            ).toBe(true);
            expect(matchesFilters(event(text("ping @eve:y please")), f, undefined, noPins)).toBe(true);
        });

        it("rejects messages that mention someone else", () => {
            const ev = event({ ...text("hello"), "m.mentions": { user_ids: ["@bob:y"] } });
            expect(matchesFilters(ev, f, undefined, noPins)).toBe(false);
        });
    });

    describe("dates", () => {
        it("before excludes the named day and later", () => {
            const f = filters("before:2026-03-28");
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-27", 23) }), f, undefined, noPins)).toBe(true);
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-28", 0) }), f, undefined, noPins)).toBe(false);
        });

        it("after excludes the named day and earlier", () => {
            const f = filters("after:2026-03-28");
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-28", 23) }), f, undefined, noPins)).toBe(false);
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-29", 0) }), f, undefined, noPins)).toBe(true);
        });

        it("during is exactly that day", () => {
            const f = filters("during:2026-03-28");
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-28", 0) }), f, undefined, noPins)).toBe(true);
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-28", 23) }), f, undefined, noPins)).toBe(true);
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-29", 0) }), f, undefined, noPins)).toBe(false);
            expect(matchesFilters(event(text("x"), { ts: day("2026-03-27", 23) }), f, undefined, noPins)).toBe(false);
        });

        it("combines a range", () => {
            const bounds = dateBounds(filters("after:2026-03-01 before:2026-03-10"));
            expect(bounds.min).toBe(day("2026-03-02", 0));
            expect(bounds.max).toBe(day("2026-03-10", 0));
        });
    });

    describe("pinned:", () => {
        const ctx: FilterContext = { isPinned: (room, id) => room === "!a:x" && id === "$pin" };

        it("true keeps only pinned events", () => {
            const f = filters("pinned:true");
            expect(matchesFilters(event(text("x"), { id: "$pin" }), f, undefined, ctx)).toBe(true);
            expect(matchesFilters(event(text("x"), { id: "$other" }), f, undefined, ctx)).toBe(false);
        });

        it("false keeps only unpinned events", () => {
            const f = filters("pinned:false");
            expect(matchesFilters(event(text("x"), { id: "$pin" }), f, undefined, ctx)).toBe(false);
            expect(matchesFilters(event(text("x"), { id: "$other" }), f, undefined, ctx)).toBe(true);
        });
    });

    it("treats m.notice as a bot message", () => {
        const notice = event({ msgtype: "m.notice", body: "deployed" });
        expect(matchesFilters(notice, filters("bot:true"), undefined, noPins)).toBe(true);
        expect(matchesFilters(notice, filters("bot:false"), undefined, noPins)).toBe(false);
        expect(matchesFilters(event(text("hi")), filters("bot:false"), undefined, noPins)).toBe(true);
    });
});
