/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
    type Contribution,
    CountConfidence,
    type LedgerEventInput,
    MAIN_SCOPE,
    RoomCountLedger,
    type SavedLedger,
    trimSavedLedger,
    UNTHREADED_RECEIPT,
} from "./RoomCountLedger";

const NOTIFY: Contribution = { notify: true, highlight: false, final: true };
const HIGHLIGHT: Contribution = { notify: true, highlight: true, final: true };
const SILENT: Contribution = { notify: false, highlight: false, final: true };
const ENCRYPTED: Contribution = { notify: true, highlight: false, final: false };

function events(...ids: string[]): LedgerEventInput[] {
    return ids.map((id) => ({ id, own: false }));
}

/** A ledger holding the given stretch as the newest events, all notifying, with every receipt known. */
function ledgerWith(ids: string[], contribution: Contribution = NOTIFY): RoomCountLedger {
    const ledger = new RoomCountLedger();
    ledger.addRun(events(...ids), { kind: "live", continuesTip: false });
    for (const id of ids) ledger.setContribution(id, contribution);
    ledger.setReceiptsComplete();
    return ledger;
}

describe("RoomCountLedger", () => {
    it("counts the notifying events after the read receipt, exactly", () => {
        const ledger = ledgerWith(["a", "b", "c", "d"]);
        ledger.setContribution("d", HIGHLIGHT);
        ledger.setReceipt(MAIN_SCOPE, "public", "b");

        expect(ledger.compute().main).toEqual({ total: 2, highlight: 1, confidence: CountConfidence.Exact });
    });

    it("counts nothing for a room read up to its newest event", () => {
        const ledger = ledgerWith(["a", "b"]);
        ledger.setReceipt(UNTHREADED_RECEIPT, "public", "b");

        expect(ledger.compute().main).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("does not count events that do not notify", () => {
        const ledger = ledgerWith(["a", "b", "c"], SILENT);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");

        expect(ledger.compute().main).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("counts nothing for certain until the room's receipts are known", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun(events("a", "b"), { kind: "live", continuesTip: false });
        ledger.setContribution("a", NOTIFY);
        ledger.setContribution("b", NOTIFY);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");

        // "b" is unread whatever other receipt there is: but it could be read by one not known yet.
        expect(ledger.compute().main).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Unknown });
        ledger.setReceiptsComplete();
        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("takes either receipt kind, and the later of the two", () => {
        const ledger = ledgerWith(["a", "b", "c", "d"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");
        ledger.setReceipt(MAIN_SCOPE, "private", "c");

        expect(ledger.compute().main.total).toBe(1);
    });

    it("never moves a receipt back to an earlier known event", () => {
        const ledger = ledgerWith(["a", "b", "c"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "c");
        ledger.setReceipt(MAIN_SCOPE, "public", "a");

        expect(ledger.compute().main.total).toBe(0);
    });

    it("treats the user's own events as read receipts", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun([...events("a", "b"), { id: "mine", own: true }, ...events("c")], {
            kind: "live",
            continuesTip: false,
        });
        for (const id of ["a", "b", "c"]) ledger.setContribution(id, NOTIFY);
        ledger.setReceiptsComplete();
        ledger.setReceipt(MAIN_SCOPE, "public", "a");

        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("counts everything after the user's join when they have no receipt", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun([...events("before"), { id: "join", own: true, joins: true }, ...events("a", "b")], {
            kind: "live",
            continuesTip: false,
        });
        for (const id of ["before", "a", "b"]) ledger.setContribution(id, NOTIFY);
        ledger.setReceiptsComplete();
        ledger.setJoined(true);

        expect(ledger.compute().threads).toEqual(new Map());
        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("counts a thread from the user's join too", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun(
            [
                { id: "root", own: false },
                { id: "early", own: false, threadRoot: "root" },
                { id: "join", own: true, joins: true },
                { id: "late", own: false, threadRoot: "root" },
            ],
            { kind: "live", continuesTip: false },
        );
        for (const id of ["root", "early", "late"]) ledger.setContribution(id, NOTIFY);
        ledger.setReceiptsComplete();
        ledger.setJoined(true);

        expect(ledger.compute().threads.get("root")).toEqual({
            total: 1,
            highlight: 0,
            confidence: CountConfidence.Exact,
        });
    });

    it("places a join it does not have before the newest segment", () => {
        const ledger = ledgerWith(["a", "b"]);
        ledger.setJoined(true);

        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.LowerBound });
    });

    it("counts nothing for certain when nothing marks where unread events start", () => {
        const ledger = ledgerWith(["a", "b"]);

        expect(ledger.compute().main).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Unknown });
    });

    it("gives a lower bound when the receipt is older than every event known", () => {
        const ledger = ledgerWith(["c", "d"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "unseen");

        // Whatever came between "unseen" and "c" is not known.
        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.LowerBound });
    });

    it("keeps events across a gap, and becomes exact once history fills it", () => {
        const ledger = ledgerWith(["a", "b", "c"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "b");
        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });

        // A sync that skipped "d" and "e".
        ledger.addRun(events("f", "g"), { kind: "live", continuesTip: false });
        ledger.setContribution("f", NOTIFY);
        ledger.setContribution("g", NOTIFY);
        // "c" could have been redacted in the gap: it counts as last seen.
        expect(ledger.compute().main).toEqual({ total: 3, highlight: 0, confidence: CountConfidence.LastKnown });

        // History before "f" reaches back to "c".
        ledger.addRun(events("c", "d", "e"), { kind: "before", anchor: "f" });
        ledger.setContribution("d", NOTIFY);
        ledger.setContribution("e", SILENT);
        expect(ledger.compute().main).toEqual({ total: 4, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("leaves events of an older segment unresolved against a receipt it cannot place", () => {
        const ledger = ledgerWith(["a", "b"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");
        ledger.addRun(events("x", "y"), { kind: "live", continuesTip: false });
        ledger.setContribution("x", NOTIFY);
        ledger.setContribution("y", NOTIFY);
        // Read on another device up to an event in the gap, or the one before "a": "b" may or may not be read.
        ledger.setReceipt(MAIN_SCOPE, "public", "in-the-gap");

        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.LowerBound });
        // Its event arrives: it was after "b".
        ledger.addRun(events("b", "in-the-gap"), { kind: "after", anchor: "a" });
        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.LowerBound });
        ledger.addRun(events("in-the-gap", "x"), { kind: "before", anchor: "x" });
        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("drops history it cannot place", () => {
        const ledger = ledgerWith(["a"]);

        expect(ledger.addRun(events("old"), { kind: "before", anchor: "unknown" })).toBe(false);
        expect(ledger.has("old")).toBe(false);
    });

    it("appends sync events that follow on from the newest one", () => {
        const ledger = ledgerWith(["a", "b"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "b");
        ledger.addRun(events("c"), { kind: "live", continuesTip: true });
        ledger.setContribution("c", NOTIFY);

        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("merges a sync timeline that overlaps what it knows", () => {
        const ledger = ledgerWith(["c", "d"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "c");
        ledger.addRun(events("a", "b", "c", "d", "e"), { kind: "live", continuesTip: false });
        for (const id of ["a", "b", "e"]) ledger.setContribution(id, NOTIFY);

        expect(ledger.size).toBe(5);
        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("counts thread replies in their thread, apart from the main timeline", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun(
            [
                { id: "root", own: false },
                { id: "r1", own: false, threadRoot: "root" },
                { id: "m1", own: false },
                { id: "r2", own: false, threadRoot: "root" },
            ],
            { kind: "live", continuesTip: false },
        );
        for (const id of ["root", "r1", "m1", "r2"]) ledger.setContribution(id, NOTIFY);
        ledger.setReceiptsComplete();
        ledger.setJoined(true);
        ledger.setReceipt(MAIN_SCOPE, "public", "m1");
        ledger.setReceipt("root", "public", "r1");

        let counts = ledger.compute();
        // Reading the main timeline does not read the thread; the thread's receipt reads only the thread.
        expect(counts.main).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Exact });
        expect(counts.threads.get("root")).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });

        // A receipt without a thread reads every scope up to its event.
        ledger.setReceipt(UNTHREADED_RECEIPT, "public", "r2");
        counts = ledger.compute();
        expect(counts.threads.get("root")).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("counts relations in the scope of the event they relate to", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun(
            [
                { id: "root", own: false },
                { id: "reply", own: false, threadRoot: "root" },
                { id: "edit", own: false, relatesTo: "reply" },
                { id: "reaction", own: false, relatesTo: "root" },
            ],
            { kind: "live", continuesTip: false },
        );
        ledger.setContribution("root", SILENT);
        ledger.setContribution("reply", SILENT);
        ledger.setContribution("edit", NOTIFY);
        ledger.setContribution("reaction", NOTIFY);
        ledger.setReceiptsComplete();
        ledger.setJoined(true);
        ledger.setReceipt(MAIN_SCOPE, "public", "root");
        ledger.setReceipt("root", "public", "root");

        const counts = ledger.compute();
        expect(counts.threads.get("root")?.total).toBe(1);
        expect(counts.main.total).toBe(1);
    });

    it("counts a notifying relation to an unknown event nowhere, and no scope as exact, until its scope is known", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun(
            [
                { id: "root", own: false },
                { id: "reply", own: false, threadRoot: "root" },
            ],
            { kind: "live", continuesTip: false },
        );
        ledger.setContribution("root", SILENT);
        ledger.setContribution("reply", SILENT);
        ledger.setReceiptsComplete();
        ledger.setReceipt(MAIN_SCOPE, "public", "root");
        ledger.setReceipt("root", "public", "reply");
        // Relates to a reply of the thread that was not seen, or to anything else.
        ledger.addRun([{ id: "edit", own: false, relatesTo: "unseen-reply" }], { kind: "live", continuesTip: true });
        ledger.setContribution("edit", NOTIFY);
        // The thread's receipt reads it, if it belongs there.
        ledger.setReceipt("root", "public", "edit");

        let counts = ledger.compute();
        expect(counts.main).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Unknown });
        expect(counts.threads.get("root")).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Unknown });

        // A receipt covering every scope reads it wherever it belongs.
        ledger.setReceipt(UNTHREADED_RECEIPT, "public", "edit");
        counts = ledger.compute();
        expect(counts.main.confidence).toBe(CountConfidence.Exact);
        expect(counts.threads.get("root")?.confidence).toBe(CountConfidence.Exact);
    });

    it("applies a redaction that arrived before the event it redacts", () => {
        const ledger = ledgerWith(["a"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");
        ledger.setRedacted("b", true);
        ledger.addRun(events("b", "c"), { kind: "live", continuesTip: true });
        ledger.setContribution("b", NOTIFY);
        ledger.setContribution("c", NOTIFY);

        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("keeps a receipt that history placed when another it cannot place replaces it", () => {
        const ledger = ledgerWith(["a", "b"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");
        ledger.addRun(events("d", "e"), { kind: "live", continuesTip: false });
        ledger.setContribution("d", NOTIFY);
        ledger.setContribution("e", NOTIFY);
        // Read up to an event in the gap, which history then fills.
        ledger.setReceipt(MAIN_SCOPE, "public", "c");
        ledger.addRun(events("b", "c"), { kind: "before", anchor: "d" });
        ledger.setContribution("c", NOTIFY);
        // A later receipt for an event opened from a link.
        ledger.setReceipt(MAIN_SCOPE, "public", "old-event-from-a-link");

        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("places a receipt made here for an event it does not have only once a later response is applied", () => {
        const ledger = ledgerWith(["a", "b", "c"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");
        // Such as for a newer event opened from a link while sync is behind: it may read "b" and "c" already.
        ledger.setReceipt(MAIN_SCOPE, "public", "newer-than-anything-known", false);
        expect(ledger.compute().main).toEqual({ total: 0, highlight: 0, confidence: CountConfidence.Unknown });

        // Sync has caught up without bringing it: it is older than what is known.
        ledger.settleReceipts();
        expect(ledger.compute().main).toEqual({ total: 2, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("does not take the user's own relation to an event not seen as reading the main timeline", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun([...events("a", "b"), { id: "reaction", own: true, relatesTo: "unseen-thread-reply" }], {
            kind: "live",
            continuesTip: false,
        });
        ledger.setContribution("a", NOTIFY);
        ledger.setContribution("b", NOTIFY);
        ledger.setReceiptsComplete();
        ledger.setReceipt(MAIN_SCOPE, "public", "a");

        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("keeps a known receipt when a receipt it cannot place arrives after it", () => {
        const ledger = ledgerWith(["a", "b", "c", "d"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "c");
        // Such as one sent here for an old event opened from a link: older, and ignored by the server.
        ledger.setReceipt(MAIN_SCOPE, "public", "old-event-from-a-link");

        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });
        // Once its event is known, it is placed like any other.
        ledger.addRun(events("old-event-from-a-link", "a"), { kind: "before", anchor: "a" });
        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.Exact });
    });

    it("stops counting a redacted event, and counts it again if the redaction is undone", () => {
        const ledger = ledgerWith(["a", "b"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");
        ledger.setRedacted("b", true);
        expect(ledger.compute().main.total).toBe(0);
        ledger.setRedacted("b", false);
        expect(ledger.compute().main.total).toBe(1);
    });

    it("does not count an event the push rules could not fully see, and says the count is not exact", () => {
        const ledger = ledgerWith(["a", "b", "c"]);
        ledger.setReceipt(MAIN_SCOPE, "public", "a");
        ledger.setContribution("c", ENCRYPTED);

        expect(ledger.compute().main).toEqual({ total: 1, highlight: 0, confidence: CountConfidence.LowerBound });
        // It waits until it is forgotten, such as once decrypted, rather than being evaluated again and again.
        expect(ledger.unevaluated()).toEqual([]);
        ledger.forgetContribution("c");
        expect(ledger.unevaluated()).toEqual(["c"]);
    });

    it("lists the events that could count and have not been evaluated", () => {
        const ledger = new RoomCountLedger();
        ledger.addRun([...events("a", "b"), { id: "mine", own: true }, ...events("c")], {
            kind: "live",
            continuesTip: false,
        });
        ledger.setReceiptsComplete();
        ledger.setReceipt(MAIN_SCOPE, "public", "a");

        // "b" is read by the user's own event after it; "a" by the receipt.
        expect(ledger.unevaluated()).toEqual(["c"]);
    });

    it("lets go of the oldest events past its limit, and no longer claims exactness that relied on them", () => {
        const ids = Array.from({ length: 2100 }, (_, i) => `e${i}`);
        const ledger = ledgerWith(ids);
        ledger.setReceipt(MAIN_SCOPE, "public", "e0");

        expect(ledger.size).toBe(2000);
        expect(ledger.compute().main).toEqual({ total: 2000, highlight: 0, confidence: CountConfidence.LowerBound });
    });

    describe("saved and restored", () => {
        it("restores the same counts", () => {
            const ledger = new RoomCountLedger();
            ledger.addRun(
                [
                    { id: "root", own: false },
                    { id: "join", own: true, joins: true },
                    { id: "r1", own: false, threadRoot: "root" },
                    { id: "edit", own: false, relatesTo: "r1" },
                    { id: "m1", own: false },
                ],
                { kind: "live", continuesTip: false },
            );
            ledger.addRun(events("m2", "m3"), { kind: "live", continuesTip: false });
            for (const id of ["root", "r1", "m1", "m2"]) ledger.setContribution(id, NOTIFY);
            ledger.setContribution("edit", SILENT);
            ledger.setContribution("m3", ENCRYPTED);
            ledger.setRedacted("m1", true);
            ledger.setReceipt(MAIN_SCOPE, "private", "root");
            // One it cannot place is kept beside it.
            ledger.setReceipt(MAIN_SCOPE, "private", "unseen");
            ledger.setReceipt("root", "public", "r1");
            ledger.setReceiptsComplete();
            ledger.setJoined(true);

            const restored = RoomCountLedger.restore(ledger.save())!;
            restored.setJoined(true);
            expect(restored.compute()).toEqual(ledger.compute());
            expect(restored.unevaluated()).toEqual(ledger.unevaluated());
            // It carries on as the original would.
            for (const copy of [ledger, restored]) {
                copy.addRun(events("m4"), { kind: "live", continuesTip: true });
                copy.setContribution("m4", HIGHLIGHT);
            }
            expect(restored.compute()).toEqual(ledger.compute());
        });

        it("saves only the newest events, and then claims no more than it knows", () => {
            const ids = Array.from({ length: 400 }, (_, i) => `e${i}`);
            const ledger = ledgerWith(ids);
            ledger.setJoined(true);
            ledger.setReceipt(MAIN_SCOPE, "public", "e350");
            let restored = RoomCountLedger.restore(ledger.save())!;
            restored.setJoined(true);
            expect(restored.size).toBe(300);
            expect(restored.compute().main).toEqual({ total: 49, highlight: 0, confidence: CountConfidence.Exact });

            // Its receipt is among the events left out: everything kept is unread, which is still true.
            const other = ledgerWith(ids);
            other.setReceipt(MAIN_SCOPE, "public", "e50");
            restored = RoomCountLedger.restore(other.save())!;
            expect(restored.compute().main).toEqual({
                total: 300,
                highlight: 0,
                confidence: CountConfidence.LowerBound,
            });
        });

        it("keeps only the newest events when trimmed", () => {
            const ledger = ledgerWith(["a", "b"]);
            ledger.addRun(events("c", "d", "e"), { kind: "live", continuesTip: false });
            const ids = (limit: number): string[][] =>
                trimSavedLedger(ledger.save(), limit).segments.map((segment) => segment.map(([id]) => id));

            expect(ids(4)).toEqual([["b"], ["c", "d", "e"]]);
            expect(ids(2)).toEqual([["d", "e"]]);
        });

        it("does not restore what it cannot read", () => {
            expect(RoomCountLedger.restore(undefined)).toBeUndefined();
            const old = { version: 0, segments: [], receipts: {}, receiptsComplete: true };
            // An older version's shape, which the current type does not allow.
            expect(RoomCountLedger.restore(old as unknown as SavedLedger)).toBeUndefined();
        });
    });

    describe("against a full history", () => {
        interface Model {
            ids: string[];
            own: Set<string>;
            threadOf: Map<string, string>;
            contribution: Map<string, Contribution>;
            receipts: Array<{ scope: string; at: number }>;
            /** Redaction events, and the earlier event each redacts. */
            redacts: Map<string, string>;
        }

        /** A small deterministic random generator, so failures can be replayed. */
        function random(seed: number): () => number {
            let state = seed;
            return () => {
                state = (state * 1103515245 + 12345) % 2147483648;
                return state / 2147483648;
            };
        }

        function makeModel(next: () => number, length: number): Model {
            const ids = Array.from({ length }, (_, i) => `e${i}`);
            const own = new Set<string>();
            const threadOf = new Map<string, string>();
            const contribution = new Map<string, Contribution>();
            for (const [i, id] of ids.entries()) {
                if (i > 0 && next() < 0.1) own.add(id);
                if (i > 2 && next() < 0.3) threadOf.set(id, ids[Math.floor(next() * 2)]);
                const roll = next();
                contribution.set(id, roll < 0.2 ? HIGHLIGHT : roll < 0.7 ? NOTIFY : SILENT);
            }
            const receipts: Model["receipts"] = [];
            for (let i = 0; i < 3; i++) {
                const scope = [MAIN_SCOPE, UNTHREADED_RECEIPT, ids[0], ids[1]][Math.floor(next() * 4)];
                receipts.push({ scope, at: Math.floor(next() * length) });
            }
            const redacts = new Map<string, string>();
            for (let i = 0; i < 2; i++) {
                const at = 3 + Math.floor(next() * (length - 3));
                const redaction = ids[at];
                if (own.has(redaction) || threadOf.has(redaction)) continue;
                redacts.set(redaction, ids[Math.floor(next() * at)]);
                contribution.set(redaction, SILENT);
            }
            return { ids, own, threadOf, contribution, receipts, redacts };
        }

        /** The counts by scope, from the whole history. The user joined before the first event. */
        function expected(model: Model): Map<string, { total: number; highlight: number }> {
            const scopeOf = (id: string): string => model.threadOf.get(id) ?? MAIN_SCOPE;
            const frontier = (scope: string): number => {
                let at = -1;
                for (const receipt of model.receipts) {
                    if (receipt.scope === scope || receipt.scope === UNTHREADED_RECEIPT) at = Math.max(at, receipt.at);
                }
                model.ids.forEach((id, i) => {
                    if (model.own.has(id) && scopeOf(id) === scope) at = Math.max(at, i);
                });
                return at;
            };
            const result = new Map<string, { total: number; highlight: number }>();
            model.ids.forEach((id, i) => {
                const scope = scopeOf(id);
                const entry = result.get(scope) ?? { total: 0, highlight: 0 };
                result.set(scope, entry);
                if (model.own.has(id) || i <= frontier(scope)) return;
                if ([...model.redacts.values()].includes(id)) return;
                const contribution = model.contribution.get(id)!;
                if (contribution.notify) entry.total++;
                if (contribution.highlight) entry.highlight++;
            });
            return result;
        }

        function input(model: Model, id: string): LedgerEventInput {
            return { id, own: model.own.has(id), threadRoot: model.threadOf.get(id) };
        }

        it("matches whenever it says it is exact, and never counts more than there is", () => {
            const seen = { exact: 0, inexact: 0, lastKnown: 0 };
            for (let seed = 1; seed <= 300; seed++) {
                const next = random(seed);
                const model = makeModel(next, 30);
                const truth = expected(model);
                const ledger = new RoomCountLedger();
                ledger.setReceiptsComplete();
                ledger.setJoined(true);

                // Deliver the history as sync does, newest stretches with gaps, then fill some gaps with history.
                const cuts = [0, ...[1, 2, 3].map(() => Math.floor(next() * 30)).sort((a, b) => a - b), 30];
                const stretches: string[][] = [];
                for (let i = 0; i < cuts.length - 1; i++) {
                    // Some stretches are skipped entirely: a gap that history may never fill.
                    if (next() < 0.3 && i < cuts.length - 2) continue;
                    const from = Math.max(0, cuts[i] - (next() < 0.5 ? 2 : 0));
                    const stretch = model.ids.slice(from, cuts[i + 1]);
                    if (stretch.length > 0) stretches.push(stretch);
                }
                // A redaction is only learnt of when the redaction itself arrives.
                const learnRedactions = (delivered: string[]): void => {
                    for (const id of delivered) {
                        const target = model.redacts.get(id);
                        if (target) ledger.setRedacted(target, true);
                    }
                };
                stretches.forEach((stretch, i) => {
                    const continuesTip = i > 0 && stretches[i - 1][stretches[i - 1].length - 1] === stretch[0];
                    ledger.addRun(
                        stretch.map((id) => input(model, id)),
                        { kind: "live", continuesTip },
                    );
                    learnRedactions(stretch);
                });
                for (const id of model.ids) ledger.setContribution(id, model.contribution.get(id)!);
                // Receipts only move forward, as the server keeps them.
                for (const receipt of [...model.receipts].sort((a, b) => a.at - b.at)) {
                    ledger.setReceipt(receipt.scope, "public", model.ids[receipt.at]);
                }
                if (next() < 0.5) {
                    // History before the newest stretch, reaching back across its gap.
                    const newest = stretches[stretches.length - 1];
                    const start = model.ids.indexOf(newest[0]);
                    const page = model.ids.slice(Math.max(0, start - 10), start);
                    if (page.length > 0) {
                        ledger.addRun(
                            page.map((id) => input(model, id)),
                            { kind: "before", anchor: newest[0] },
                        );
                        for (const id of page) ledger.setContribution(id, model.contribution.get(id)!);
                        learnRedactions(page);
                    }
                }

                const counts = ledger.compute();
                const scopes: Array<[string, ReturnType<RoomCountLedger["compute"]>["main"]]> = [
                    [MAIN_SCOPE, counts.main],
                    ...counts.threads,
                ];
                for (const [scope, got] of scopes) {
                    const want = truth.get(scope) ?? { total: 0, highlight: 0 };
                    // The seed and scope are in what is compared, so a failure says which case it was.
                    if (got.confidence === CountConfidence.Exact) {
                        seen.exact++;
                        expect({ seed, scope, total: got.total, highlight: got.highlight }).toEqual({
                            seed,
                            scope,
                            ...want,
                        });
                    } else if (got.confidence === CountConfidence.LastKnown) {
                        // As last seen: only a redaction in a gap can make it too high.
                        seen.lastKnown++;
                    } else {
                        seen.inexact++;
                        const over = got.total > want.total || got.highlight > want.highlight;
                        expect({ seed, scope, over }).toEqual({ seed, scope, over: false });
                    }
                }
            }
            // Both outcomes are exercised.
            expect(seen.exact).toBeGreaterThan(100);
            expect(seen.inexact).toBeGreaterThan(100);
            expect(seen.lastKnown).toBeGreaterThan(10);
        });
    });
});
