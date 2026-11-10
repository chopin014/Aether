/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** One benchmark's results: each metric's samples in milliseconds. */
export type Samples = Record<string, number[]>;

/** A long task, in the page's time: when it started and how long it ran, in milliseconds. */
export interface LongTask {
    start: number;
    duration: number;
}

/** A metric's summary: how many samples, their median, 95th percentile and largest. */
export interface MetricSummary {
    n: number;
    p50: number;
    p95: number;
    max: number;
}

/** The `p`th percentile of `samples` by the nearest-rank method; undefined for no samples. */
export function percentile(samples: readonly number[], p: number): number | undefined {
    if (samples.length === 0) return undefined;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Each metric with samples, summarised; metrics without any are left out. */
export function summarise(samples: Samples): Record<string, MetricSummary> {
    return Object.fromEntries(
        Object.entries(samples)
            .filter(([, values]) => values.length > 0)
            .map(([metric, values]) => [
                metric,
                {
                    n: values.length,
                    p50: percentile(values, 50)!,
                    p95: percentile(values, 95)!,
                    max: Math.max(...values),
                },
            ]),
    );
}

/** Record `value`, rounded to a whole millisecond, under `metric`. A missing or not-a-number value is left out. */
export function add(samples: Samples, metric: string, value: number | undefined): void {
    if (value === undefined || Number.isNaN(value)) return;
    (samples[metric] ??= []).push(Math.round(value));
}

/** The tasks running at some point from `from` to `to`, a task that started earlier and ran into that time included. */
export function overlapping(tasks: readonly LongTask[], from: number, to: number): LongTask[] {
    return tasks.filter((task) => task.start + task.duration > from && task.start < to);
}

/** The duration of the longest task running at some point from `from` to `to`, whole; 0 for none. */
export function longestOverlapping(tasks: readonly LongTask[], from: number, to: number): number {
    return Math.max(0, ...overlapping(tasks, from, to).map((task) => task.duration));
}

/**
 * The blocking time from `from` to `to`: the part of each task beyond its first 50 ms. Only what falls inside the
 * window counts, for a task that started before it or ends after it.
 */
export function blockingWithin(tasks: readonly LongTask[], from: number, to: number): number {
    return overlapping(tasks, from, to).reduce(
        (sum, task) => sum + Math.max(0, Math.min(task.start + task.duration, to) - Math.max(task.start + 50, from)),
        0,
    );
}
