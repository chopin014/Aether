/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { type CertainCount, CountCertaintySum } from "./CountCertaintySum";

describe("CountCertaintySum", () => {
    const exact = (count: number): CertainCount => ({ count, countIsLowerBound: false, countIsApproximate: false });
    const lowerBound = (count: number): CertainCount => ({ count, countIsLowerBound: true, countIsApproximate: false });
    const approximate = (count: number): CertainCount => ({
        count,
        countIsLowerBound: false,
        countIsApproximate: true,
    });

    function sum(...counts: CertainCount[]): CountCertaintySum {
        const result = new CountCertaintySum();
        counts.forEach((count) => result.add(count));
        return result;
    }

    it("is exact with only exact counts, or none", () => {
        expect(sum()).toMatchObject({ countIsLowerBound: false, countIsApproximate: false });
        expect(sum(exact(2), exact(3))).toMatchObject({ countIsLowerBound: false, countIsApproximate: false });
    });

    it("is a lower bound with a lower bound in it", () => {
        expect(sum(exact(2), lowerBound(1))).toMatchObject({ countIsLowerBound: true, countIsApproximate: false });
    });

    it("is approximate, and no lower bound, with an approximate count in it, in whatever order", () => {
        expect(sum(lowerBound(1), approximate(5))).toMatchObject({
            countIsLowerBound: false,
            countIsApproximate: true,
        });
        expect(sum(approximate(5), lowerBound(1))).toMatchObject({
            countIsLowerBound: false,
            countIsApproximate: true,
        });
    });

    it("takes no doubt from counts of zero", () => {
        expect(sum(exact(2), lowerBound(0), approximate(0))).toMatchObject({
            countIsLowerBound: false,
            countIsApproximate: false,
        });
    });
});
