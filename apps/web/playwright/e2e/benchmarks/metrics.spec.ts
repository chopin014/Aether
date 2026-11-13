/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// The benchmark's arithmetic, checked on its own: no page or homeserver is needed.
import { expect, test } from "@playwright/test";

import {
    add,
    blockingWithin,
    longestOverlapping,
    overlapping,
    percentile,
    type Samples,
    summarise,
    withoutProbes,
} from "./metrics";

test.describe("benchmark metrics", () => {
    test("takes percentiles by nearest rank", () => {
        const samples = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
        expect(percentile(samples, 50)).toBe(5);
        expect(percentile(samples, 95)).toBe(10);
        expect(percentile(samples, 100)).toBe(10);
        expect(percentile([42], 95)).toBe(42);
        expect(percentile([], 50)).toBeUndefined();
    });

    test("summarises only metrics with samples, rounding what is added", () => {
        const samples: Samples = {};
        add(samples, "switch", 10.4);
        add(samples, "switch", 20.6);
        add(samples, "switch", undefined);
        add(samples, "switch", Number.NaN);
        add(samples, "never", undefined);

        expect(samples).toEqual({ switch: [10, 21] });
        expect(summarise({ ...samples, empty: [] })).toEqual({ switch: { n: 2, p50: 10, p95: 21, max: 21 } });
    });

    test("counts a task that runs into the window, but not one that ends as it starts", () => {
        const tasks = [
            { start: 0, duration: 100 }, // runs into the window
            { start: 100, duration: 60 }, // ends exactly as the window starts
            { start: 200, duration: 70 }, // inside
            { start: 400, duration: 80 }, // starts as the window ends
        ];

        expect(overlapping(tasks, 160, 400)).toEqual([tasks[2]]);
        expect(overlapping(tasks, 50, 400)).toEqual([tasks[0], tasks[1], tasks[2]]);
        expect(longestOverlapping(tasks, 50, 400)).toBe(100);
        expect(longestOverlapping(tasks, 500, 600)).toBe(0);
    });

    test("counts only the blocking inside the window", () => {
        // 120 ms long, blocking from 50 ms in. The window cuts it at 100 ms, so 50 ms of it blocks inside.
        expect(blockingWithin([{ start: 0, duration: 120 }], 0, 100)).toBe(50);
        // Started before the window: only its blocking from the window's start counts.
        expect(blockingWithin([{ start: 0, duration: 120 }], 80, 200)).toBe(40);
        // Shorter than 50 ms: no blocking.
        expect(blockingWithin([{ start: 0, duration: 40 }], 0, 100)).toBe(0);
    });

    test("takes the benchmark's own work out of the tasks it ran in", () => {
        const tasks = [
            { start: 0, duration: 100 },
            { start: 200, duration: 60 },
            { start: 400, duration: 80 },
        ];
        const probes = [
            // Inside the first task.
            { start: 10, duration: 5 },
            // Running past the end of the first task: only its part inside counts.
            { start: 95, duration: 20 },
            // Enough of the second that it would not have been a long task.
            { start: 210, duration: 15 },
            // Between tasks.
            { start: 300, duration: 30 },
        ];
        expect(withoutProbes(tasks, probes)).toEqual([
            { start: 0, duration: 90 },
            { start: 400, duration: 80 },
        ]);
        expect(withoutProbes(tasks, [])).toEqual(tasks);
    });
});
