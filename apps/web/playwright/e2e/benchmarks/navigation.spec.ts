/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * How fast Aether starts and navigates, measured on a local homeserver with an account seeded with rooms, Spaces
 * and history. It runs only when AETHER_BENCHMARK is set, so the normal end-to-end suite stays quick:
 *
 *   AETHER_BENCHMARK=1 [AETHER_BENCHMARK_OUT=results.jsonl] [AETHER_BENCHMARK_RUNS=5] \
 *     [AETHER_BENCHMARK_LABS=feature_new_timeline] [AETHER_BENCHMARK_LATENCY_MS=150] \
 *     pnpm exec playwright test playwright/e2e/benchmarks --project=Chrome
 *
 * A step the build cannot do, such as opening a Space's channels, is recorded under `failures` and fails the test
 * after the other results are saved.
 *
 * Every timing is taken inside the page, from performance.now(), so Playwright's own polling does not count. The
 * account is seeded through the client-server API; nothing joins or leaves rooms on a public server.
 */

import { type APIRequestContext, type Page } from "@playwright/test";
import { rejectToastIfExists } from "@element-hq/element-web-playwright-common";

import { expect, test } from "../../element-web-test";
import type { Credentials } from "../../plugins/homeserver";

const enabled = Boolean(process.env.AETHER_BENCHMARK);
const RUNS = Number(process.env.AETHER_BENCHMARK_RUNS ?? 5);
const PLAIN_ROOMS = Number(process.env.AETHER_BENCHMARK_ROOMS ?? 120);
const SPACES = 4;
// Few enough that every channel fits on screen: the channel list is virtualised, so only rows on screen can be clicked.
const CHANNELS_PER_SPACE = 6;
// How many of each Space's channels the server switches open, leaving the rest for first channel visits.
const SERVER_SWITCH_CHANNELS = 3;
const MESSAGES_PER_ROOM = 15;
// More labs flags to turn on, comma separated, such as the ones a desktop build enables.
const EXTRA_LABS = (process.env.AETHER_BENCHMARK_LABS ?? "").split(",").filter(Boolean);
// How long each request to the homeserver is held before it is sent, in milliseconds, as a server across the
// internet would be. The app itself still loads locally, as the desktop app does.
const LATENCY_MS = Number(process.env.AETHER_BENCHMARK_LATENCY_MS ?? 0);
// How long the app is used before each restart, in milliseconds, so what it keeps on this device has been written.
const SETTLE_MS = Number(process.env.AETHER_BENCHMARK_SETTLE_MS ?? 3000);
// How long after the app shows a room at start its long tasks are counted, in milliseconds: what is left to load
// then, such as the rest of the account, must not keep the page from answering.
const AFTER_START_MS = Number(process.env.AETHER_BENCHMARK_AFTER_START_MS ?? 5000);

/** One protocol's results: each metric's samples in milliseconds. */
type Samples = Record<string, number[]>;

interface SeededAccount {
    /** A room opened directly at startup, with its newest message. */
    destination: { roomId: string; text: string };
    /** Spaces with their channels, each channel with its newest message. */
    spaces: { roomId: string; name: string; channels: { roomId: string; name: string; text: string }[] }[];
}

/** Sends client-server API requests as the seeded user. */
class Api {
    private txn = 0;

    public constructor(
        private readonly request: APIRequestContext,
        private readonly credentials: Credentials,
    ) {}

    public async createRoom(body: Record<string, unknown>): Promise<string> {
        const response = await this.call("POST", "/_matrix/client/v3/createRoom", body);
        return response.room_id as string;
    }

    public async sendMessage(roomId: string, body: string): Promise<void> {
        const txn = `bench-${Date.now()}-${this.txn++}`;
        await this.call("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, {
            msgtype: "m.text",
            body,
        });
    }

    public async sendState(roomId: string, type: string, stateKey: string, content: object): Promise<void> {
        await this.call(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/${encodeURIComponent(stateKey)}`,
            content,
        );
    }

    private async call(method: "POST" | "PUT", path: string, data: object): Promise<Record<string, unknown>> {
        for (let attempt = 0; ; attempt++) {
            const response = await this.request.fetch(`${this.credentials.homeserverBaseUrl}${path}`, {
                method,
                data,
                headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
            });
            if (response.status() === 429 && attempt < 20) {
                await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
                continue;
            }
            expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
            return (await response.json()) as Record<string, unknown>;
        }
    }
}

/** Run `tasks` with at most `limit` in flight. */
async function inBatches<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
    for (let start = 0; start < items.length; start += limit) {
        await Promise.all(items.slice(start, start + limit).map((item, offset) => task(item, start + offset)));
    }
}

async function seedRoom(api: Api, name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const roomId = await api.createRoom({ name, preset: "private_chat", ...extra });
    for (let i = 0; i < MESSAGES_PER_ROOM; i++) await api.sendMessage(roomId, `${name} message ${i}`);
    return roomId;
}

async function seedAccount(api: Api, serverName: string): Promise<SeededAccount> {
    const plain = Array.from({ length: PLAIN_ROOMS }, (_, i) => `Bench room ${i}`);
    await inBatches(plain, 8, async (name) => {
        await seedRoom(api, name);
    });
    const destinationName = "Bench destination";
    const destinationId = await seedRoom(api, destinationName);

    const spaces: SeededAccount["spaces"] = [];
    for (let s = 0; s < SPACES; s++) {
        const name = `Bench server ${s}`;
        const spaceId = await api.createRoom({ name, preset: "private_chat", creation_content: { type: "m.space" } });
        const channels: SeededAccount["spaces"][number]["channels"] = [];
        await inBatches(
            Array.from({ length: CHANNELS_PER_SPACE }, (_, c) => c),
            6,
            async (index) => {
                const channelName = `server ${s} channel ${index}`;
                const roomId = await seedRoom(api, channelName);
                // The Space lists its channels in this order whatever order the requests finish in, so the channel
                // a Space opens first is the first here.
                const order = String(index).padStart(3, "0");
                await api.sendState(spaceId, "m.space.child", roomId, { via: [serverName], order });
                await api.sendState(roomId, "m.space.parent", spaceId, { via: [serverName], canonical: true });
                channels[index] = {
                    roomId,
                    name: channelName,
                    text: `${channelName} message ${MESSAGES_PER_ROOM - 1}`,
                };
            },
        );
        spaces.push({ roomId: spaceId, name, channels });
        console.log(`[benchmark] seeded ${name}`);
    }
    return {
        destination: { roomId: destinationId, text: `${destinationName} message ${MESSAGES_PER_ROOM - 1}` },
        spaces,
    };
}

/**
 * Record, from navigation start, when a message with `text` is first painted. Installed before the app loads, so a
 * timeline drawn from a cache is seen as early as one drawn from the network.
 */
async function watchForText(page: Page, text: string): Promise<void> {
    await page.addInitScript((wanted) => {
        const win = window as unknown as { aetherBenchTextAt?: number };
        // Shown means visible to the eye: not laid out under a hidden list while the timeline places it, and inside
        // the timeline's viewport.
        const shown = (): boolean =>
            [...document.querySelectorAll(".mx_EventTile_body")].some((body) => {
                if (!body.textContent?.includes(wanted) || getComputedStyle(body).visibility !== "visible")
                    return false;
                const rect = body.getBoundingClientRect();
                const viewport = (
                    body.closest("[data-testid='timeline-scroller'], .mx_RoomView_messagePanel") ??
                    document.documentElement
                ).getBoundingClientRect();
                return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
            });
        const check = (): void => {
            if (win.aetherBenchTextAt !== undefined) return;
            // Painted on the frame after it was first seen shown, if it is still shown then.
            if (shown()) {
                requestAnimationFrame(() => {
                    if (shown()) win.aetherBenchTextAt ??= performance.now();
                    else requestAnimationFrame(check);
                });
                return;
            }
            requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
    }, text);
}

/** Record the page's long tasks from the moment each page load starts. */
async function watchLongTasks(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const win = window as unknown as { aetherBenchLongTasks?: { start: number; duration: number }[] };
        win.aetherBenchLongTasks = [];
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                win.aetherBenchLongTasks!.push({ start: entry.startTime, duration: entry.duration });
            }
        }).observe({ type: "longtask", buffered: true });
    });
}

/**
 * How the page answered in the {@link AFTER_START_MS} after the room it opened at start was shown: the longest task
 * running then, whole, and the blocking time in that window, the part of each long task beyond its first 50 ms.
 */
async function blockingAfterStart(page: Page): Promise<{ longest: number; blocking: number }> {
    await page.waitForTimeout(AFTER_START_MS);
    return page.evaluate((windowMs) => {
        const win = window as unknown as {
            aetherBenchTextAt?: number;
            aetherBenchLongTasks?: { start: number; duration: number }[];
        };
        const shownAt = win.aetherBenchTextAt!;
        const end = shownAt + windowMs;
        const tasks = (win.aetherBenchLongTasks ?? []).filter(
            (task) => task.start + task.duration > shownAt && task.start < end,
        );
        // Only the blocking inside the window counts, for a task that started before it or ends after it.
        const blockingInWindow = (task: { start: number; duration: number }): number =>
            Math.max(0, Math.min(task.start + task.duration, end) - Math.max(task.start + 50, shownAt));
        return {
            longest: Math.max(0, ...tasks.map((task) => task.duration)),
            blocking: tasks.reduce((sum, task) => sum + blockingInWindow(task), 0),
        };
    }, AFTER_START_MS);
}

/** Startup marks recorded by the app, in milliseconds since navigation. */
async function startupMarks(page: Page): Promise<Record<string, number>> {
    return page.evaluate(() =>
        Object.fromEntries(
            performance
                .getEntriesByType("mark")
                .filter((mark) => mark.name.startsWith("aether:startup:"))
                .map((mark) => [mark.name.slice("aether:startup:".length), Math.round(mark.startTime)]),
        ),
    );
}

/**
 * Time from a click to a message with `text` being painted, measured in the page.
 * @returns Milliseconds.
 */
async function timeClickToText(page: Page, click: () => Promise<void>, text: string): Promise<number> {
    await page.evaluate((wanted) => {
        const win = window as unknown as {
            aetherBenchClickAt?: number;
            aetherBenchShownAt?: number;
            aetherBenchCancel?: () => void;
        };
        // An earlier attempt that failed must not keep watching, or record into this one.
        win.aetherBenchCancel?.();
        win.aetherBenchClickAt = undefined;
        win.aetherBenchShownAt = undefined;
        let active = true;
        let frame = 0;
        const onPointerDown = (): void => {
            win.aetherBenchClickAt ??= performance.now();
        };
        document.addEventListener("pointerdown", onPointerDown, { capture: true, once: true });
        win.aetherBenchCancel = (): void => {
            active = false;
            cancelAnimationFrame(frame);
            document.removeEventListener("pointerdown", onPointerDown, { capture: true });
        };
        // Shown as in watchForText: visible, and inside the timeline's viewport.
        const shown = (): boolean =>
            [...document.querySelectorAll(".mx_EventTile_body")].some((body) => {
                if (!body.textContent?.includes(wanted) || getComputedStyle(body).visibility !== "visible")
                    return false;
                const rect = body.getBoundingClientRect();
                const viewport = (
                    body.closest("[data-testid='timeline-scroller'], .mx_RoomView_messagePanel") ??
                    document.documentElement
                ).getBoundingClientRect();
                return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
            });
        const check = (): void => {
            if (!active) return;
            if (win.aetherBenchClickAt !== undefined && shown()) {
                frame = requestAnimationFrame(() => {
                    if (!active) return;
                    if (shown()) {
                        win.aetherBenchShownAt = performance.now();
                        win.aetherBenchCancel?.();
                    } else {
                        frame = requestAnimationFrame(check);
                    }
                });
                return;
            }
            frame = requestAnimationFrame(check);
        };
        frame = requestAnimationFrame(check);
    }, text);
    try {
        await click();
        await page.waitForFunction(
            () => (window as unknown as { aetherBenchShownAt?: number }).aetherBenchShownAt !== undefined,
            undefined,
            { timeout: 30_000 },
        );
        return await page.evaluate(() => {
            const win = window as unknown as { aetherBenchClickAt: number; aetherBenchShownAt: number };
            return Math.round(win.aetherBenchShownAt - win.aetherBenchClickAt);
        });
    } finally {
        await page.evaluate(() => (window as unknown as { aetherBenchCancel?: () => void }).aetherBenchCancel?.());
    }
}

/** Close the toasts that can cover the room list, such as "Verify this device". */
async function dismissToasts(page: Page): Promise<void> {
    await rejectToastIfExists(page, "Verify this device", { timeout: 50 });
    if (await rejectToastIfExists(page, "Turn on key storage", { timeout: 50 })) {
        await page.getByRole("button", { name: "Yes, dismiss" }).click();
    }
    await rejectToastIfExists(page, "Notifications", { timeout: 50 });
}

/**
 * {@link timeClickToText}, with toasts closed first so they cannot block the click. Closing them happens outside the
 * measurement, because clicking a toast would count as the click being timed. A toast that appears during the click
 * blocks it, so the measurement is taken again; the first try already moved there, so its sample is not kept.
 * @param click - Clicks through to the message. Each click must fail rather than wait when it is blocked.
 * @returns Milliseconds, or undefined when the measurement had to be taken again.
 */
async function measureClick(page: Page, click: () => Promise<void>, text: string): Promise<number | undefined> {
    for (let attempt = 0; ; attempt++) {
        await dismissToasts(page);
        try {
            const ms = await timeClickToText(page, click, text);
            return attempt === 0 ? ms : undefined;
        } catch (error) {
            if (attempt === 2) throw error;
            console.log(`[benchmark] click blocked, measuring again: ${String(error).split("\n")[0]}`);
        }
    }
}

const CLICK_TIMEOUT = 10_000;

function percentile(samples: number[], p: number): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarise(samples: Samples): Record<string, { n: number; p50: number; p95: number; max: number }> {
    return Object.fromEntries(
        Object.entries(samples)
            .filter(([, values]) => values.length > 0)
            .map(([metric, values]) => [
                metric,
                {
                    n: values.length,
                    p50: percentile(values, 50),
                    p95: percentile(values, 95),
                    max: Math.max(...values),
                },
            ]),
    );
}

function add(samples: Samples, metric: string, value: number | undefined): void {
    if (value === undefined || Number.isNaN(value)) return;
    (samples[metric] ??= []).push(Math.round(value));
}

for (const protocol of ["regular", "sliding"] as const) {
    test.describe(`navigation benchmark (${protocol} sync)`, () => {
        test.skip(!enabled, "Set AETHER_BENCHMARK=1 to run the benchmarks");
        test.use({
            displayName: "Bench",
            labsFlags: [
                "feature_desktop_shell",
                ...(protocol === "sliding" ? ["feature_simplified_sliding_sync"] : []),
                ...EXTRA_LABS,
            ],
        });

        test(`starts and navigates (${protocol})`, async ({
            pageWithCredentials: page,
            request,
            credentials,
            homeserver,
        }, testInfo) => {
            test.setTimeout(30 * 60_000);
            const api = new Api(request, credentials);
            const progress = (step: string): void => console.log(`[benchmark ${protocol}] ${step}`);
            progress("seeding");
            const seeded = await seedAccount(api, credentials.homeServer);
            progress("seeded");
            const samples: Samples = {};
            if (LATENCY_MS > 0) {
                await page.route(`${homeserver.baseUrl}/**`, async (route) => {
                    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
                    await route.fallback();
                });
            }

            // Opening the account for the first time on this device: nothing is cached.
            await watchForText(page, seeded.destination.text);
            await watchLongTasks(page);
            await page.goto(`/#/room/${seeded.destination.roomId}`);
            await page.waitForFunction(
                () => (window as unknown as { aetherBenchTextAt?: number }).aetherBenchTextAt !== undefined,
                undefined,
                { timeout: 120_000 },
            );
            add(
                samples,
                "fresh: destination text",
                await page.evaluate(() => (window as unknown as { aetherBenchTextAt?: number }).aetherBenchTextAt),
            );
            for (const [mark, ms] of Object.entries(await startupMarks(page))) add(samples, `fresh: ${mark}`, ms);
            const fresh = await blockingAfterStart(page);
            add(samples, "fresh: longest task after shown", fresh.longest);
            add(samples, "fresh: blocking after shown", fresh.blocking);

            progress("fresh start measured");
            // Coming back: the app restarts with whatever it keeps on this device.
            for (let run = 0; run < RUNS; run++) {
                await page.waitForTimeout(SETTLE_MS);
                await page.reload();
                await page.waitForFunction(
                    () => (window as unknown as { aetherBenchTextAt?: number }).aetherBenchTextAt !== undefined,
                    undefined,
                    { timeout: 120_000 },
                );
                add(
                    samples,
                    "warm: destination text",
                    await page.evaluate(() => (window as unknown as { aetherBenchTextAt?: number }).aetherBenchTextAt),
                );
                for (const [mark, ms] of Object.entries(await startupMarks(page))) add(samples, `warm: ${mark}`, ms);
                const warm = await blockingAfterStart(page);
                add(samples, "warm: longest task after shown", warm.longest);
                add(samples, "warm: blocking after shown", warm.blocking);
            }

            progress("warm starts measured");
            // A step that cannot be done is recorded, and the rest are still measured and saved.
            const failures: Record<string, string> = {};
            const step = async (name: string, measure: () => Promise<void>): Promise<void> => {
                try {
                    await measure();
                    progress(`${name} measured`);
                } catch (error) {
                    failures[name] = String(error).split("\n")[0];
                    progress(`${name} failed: ${failures[name]}`);
                }
            };
            // Switching servers, then opening channels inside one. Server switches only use the first channels of
            // each Space, so the channel switches below still have channels nobody has opened.
            const rail = page.getByRole("tree", { name: "Servers" });
            const opened = new Set<string>();
            let current: string | undefined;
            await step("server switches", async () => {
                for (let run = 0; run < RUNS; run++) {
                    for (const space of seeded.spaces) {
                        const channel = space.channels[run % SERVER_SWITCH_CHANNELS];
                        const firstVisit = run === 0;
                        opened.add(channel.name);
                        current = channel.name;
                        add(
                            samples,
                            firstVisit ? "server switch: first visit, first channel" : "server switch: visited",
                            await measureClick(
                                page,
                                async () => {
                                    await rail
                                        .getByLabel(space.name, { exact: true })
                                        .first()
                                        .click({ timeout: CLICK_TIMEOUT });
                                    await page
                                        .getByTestId("room-list")
                                        .locator(`[title="${channel.name}"]`)
                                        .first()
                                        .click({ timeout: CLICK_TIMEOUT });
                                },
                                channel.text,
                            ),
                        );
                    }
                }
            });
            await step("channel switches", async () => {
                const space = seeded.spaces[0];
                await dismissToasts(page);
                await rail.getByLabel(space.name, { exact: true }).first().click({ timeout: CLICK_TIMEOUT });
                // The Space reopens the channel last opened in it. Check, so a different choice cannot slip an open
                // channel into the measurements.
                const reopened = space.channels[(RUNS - 1) % SERVER_SWITCH_CHANNELS];
                await expect(page.locator(".mx_EventTile_body", { hasText: reopened.text }).first()).toBeVisible();
                current = reopened.name;
                for (let run = 0; run < 2; run++) {
                    for (const channel of space.channels) {
                        // Clicking the channel already open measures nothing.
                        if (channel.name === current) continue;
                        const metric = opened.has(channel.name)
                            ? "channel switch: visited"
                            : "channel switch: first visit";
                        opened.add(channel.name);
                        current = channel.name;
                        add(
                            samples,
                            metric,
                            await measureClick(
                                page,
                                () =>
                                    page
                                        .getByTestId("room-list")
                                        .locator(`[title="${channel.name}"]`)
                                        .first()
                                        .click({ timeout: CLICK_TIMEOUT }),
                                channel.text,
                            ),
                        );
                    }
                }
            });

            const summary = {
                protocol,
                rooms: PLAIN_ROOMS + 1 + SPACES * (CHANNELS_PER_SPACE + 1),
                messagesPerRoom: MESSAGES_PER_ROOM,
                runs: RUNS,
                latencyMs: LATENCY_MS,
                settleMs: SETTLE_MS,
                afterStartMs: AFTER_START_MS,
                homeserver: homeserver.baseUrl,
                metrics: summarise(samples),
                failures,
                samples,
            };
            console.log(`\n${protocol} sync benchmark\n${JSON.stringify(summary.metrics, null, 2)}`);
            await testInfo.attach(`benchmark-${protocol}.json`, {
                body: JSON.stringify(summary, null, 2),
                contentType: "application/json",
            });
            const out = process.env.AETHER_BENCHMARK_OUT;
            if (out) {
                const { appendFileSync } = await import("node:fs");
                appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), ...summary })}\n`);
            }
            expect(failures, "steps that could not be measured").toEqual({});
        });
    });
}
