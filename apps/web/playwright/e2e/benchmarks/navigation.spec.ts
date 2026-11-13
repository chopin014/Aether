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
 *     [AETHER_BENCHMARK_SWITCH_PASSES=20] [AETHER_BENCHMARK_AFTER_SWITCH_MS=300] [AETHER_BENCHMARK_ENCRYPTED=1] \
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
import {
    add,
    blockingWithin,
    type LongTask,
    longestOverlapping,
    type Samples,
    summarise,
    withoutProbes,
} from "./metrics";
import { installReadableCheck, type ReadableTarget, type ReadableWindow } from "./readableTimeline";

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
// How many passes over the first Space's channels the channel switches make. Every pass after the first gives six
// switches to channels already opened, so raising it gathers enough of them for a percentile to mean something.
const SWITCH_PASSES = Number(process.env.AETHER_BENCHMARK_SWITCH_PASSES ?? 2);
// How long after a switch shows its message its long tasks still count, in milliseconds: work put off until the message
// shows keeps the page from answering all the same.
const AFTER_SWITCH_MS = Number(process.env.AETHER_BENCHMARK_AFTER_SWITCH_MS ?? 300);
// Whether every seeded room has encryption turned on, for what the app does differently in encrypted rooms. The
// messages are still sent in the clear, as the seeding has no keys to encrypt with, so nothing is decrypted.
const ENCRYPTED = Boolean(process.env.AETHER_BENCHMARK_ENCRYPTED);

/** What {@link watchLongTasks} keeps on the page's window. */
interface LongTaskWindow {
    /** The long tasks the observer has delivered. */
    aetherBenchLongTasks?: LongTask[];
    /**
     * Every long task so far, those the observer has not delivered yet included: it delivers at low priority, so a
     * task that has ended may not have reached the list when it is read.
     */
    aetherBenchLongTasksNow?: () => LongTask[];
}

interface SeededAccount {
    /** A room opened directly at startup, as its newest message. */
    destination: ReadableTarget;
    /** Spaces with their channels, each channel as its newest message. */
    spaces: { roomId: string; name: string; channels: (ReadableTarget & { name: string })[] }[];
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

    /** Send a text message, returning its event id. */
    public async sendMessage(roomId: string, body: string): Promise<string> {
        const txn = `bench-${Date.now()}-${this.txn++}`;
        const response = await this.call(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
            { msgtype: "m.text", body },
        );
        return response.event_id as string;
    }

    public async sendState(roomId: string, type: string, stateKey: string, content: object): Promise<void> {
        await this.call(
            "PUT",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/${encodeURIComponent(stateKey)}`,
            content,
        );
    }

    public async getState(roomId: string, type: string, stateKey = ""): Promise<Record<string, unknown>> {
        return this.call(
            "GET",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/${encodeURIComponent(stateKey)}`,
        );
    }

    private async call(method: "GET" | "POST" | "PUT", path: string, data?: object): Promise<Record<string, unknown>> {
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

/** Create a room with {@link MESSAGES_PER_ROOM} messages, returning it as its newest message. */
async function seedRoom(api: Api, name: string, extra: Record<string, unknown> = {}): Promise<ReadableTarget> {
    const encryption = { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } };
    const initialState = [...(ENCRYPTED ? [encryption] : []), ...((extra.initial_state as object[] | undefined) ?? [])];
    const roomId = await api.createRoom({ name, preset: "private_chat", ...extra, initial_state: initialState });
    let eventId = "";
    for (let i = 0; i < MESSAGES_PER_ROOM; i++) eventId = await api.sendMessage(roomId, `${name} message ${i}`);
    return { roomId, eventId, text: `${name} message ${MESSAGES_PER_ROOM - 1}` };
}

async function seedAccount(api: Api, serverName: string): Promise<SeededAccount> {
    const plain = Array.from({ length: PLAIN_ROOMS }, (_, i) => `Bench room ${i}`);
    await inBatches(plain, 8, async (name) => {
        await seedRoom(api, name);
    });
    const destination = await seedRoom(api, "Bench destination");
    if (ENCRYPTED) {
        // The server applies a new room's initial state as it sees fit, so check that encryption really is on.
        const encryption = await api.getState(destination.roomId, "m.room.encryption");
        expect(encryption.algorithm, "seeded rooms are encrypted").toBe("m.megolm.v1.aes-sha2");
    }

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
                const channel = await seedRoom(api, channelName);
                // The Space lists its channels in this order whatever order the requests finish in, so the channel
                // a Space opens first is the first here.
                const order = String(index).padStart(3, "0");
                await api.sendState(spaceId, "m.space.child", channel.roomId, { via: [serverName], order });
                await api.sendState(channel.roomId, "m.space.parent", spaceId, { via: [serverName], canonical: true });
                channels[index] = { ...channel, name: channelName };
            },
        );
        spaces.push({ roomId: spaceId, name, channels });
        console.log(`[benchmark] seeded ${name}`);
    }
    return { destination, spaces };
}

/**
 * Record, from navigation start, when `target` is first painted readable; see {@link installReadableCheck}. Installed
 * before the app loads, so a timeline drawn from a cache is seen as early as one drawn from the network. Needs the
 * readable check installed before it.
 */
async function watchForText(page: Page, target: ReadableTarget): Promise<void> {
    await page.addInitScript((wanted) => {
        const win = window as unknown as ReadableWindow & { aetherBenchTextAt?: number };
        win.aetherBenchWatchReadable!(wanted, (at) => {
            win.aetherBenchTextAt ??= at;
        });
    }, target);
}

/** Record the page's long tasks from the moment each page load starts. */
async function watchLongTasks(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const win = window as unknown as LongTaskWindow;
        const tasks: LongTask[] = [];
        const record = (entries: PerformanceEntryList): void => {
            for (const entry of entries) tasks.push({ start: entry.startTime, duration: entry.duration });
        };
        const observer = new PerformanceObserver((list) => record(list.getEntries()));
        observer.observe({ type: "longtask", buffered: true });
        win.aetherBenchLongTasks = tasks;
        win.aetherBenchLongTasksNow = (): LongTask[] => {
            // Only entries not delivered yet, so none is counted twice.
            record(observer.takeRecords());
            return tasks;
        };
    });
}

/**
 * How the page answered in the {@link AFTER_START_MS} after the room it opened at start was shown: the longest task
 * running then, whole, the blocking time in that window, the part of each long task beyond its first 50 ms, and how
 * long the main thread was busy with tasks in all, short ones included.
 */
async function blockingAfterStart(page: Page): Promise<{ longest: number; blocking: number; busy: number }> {
    // Main-thread time spent on tasks, in seconds since the page was opened, as Chromium counts it.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const taskTime = async (): Promise<number> =>
        (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
    const busyBefore = await taskTime();
    await page.waitForTimeout(AFTER_START_MS);
    const busy = Math.round(((await taskTime()) - busyBefore) * 1000);
    await cdp.detach();
    const { shownAt, pageTasks, probes } = await page.evaluate(() => {
        const win = window as unknown as LongTaskWindow & ReadableWindow & { aetherBenchTextAt?: number };
        return {
            shownAt: win.aetherBenchTextAt!,
            pageTasks: win.aetherBenchLongTasksNow?.() ?? [],
            probes: win.aetherBenchProbes ?? [],
        };
    });
    // The readable check's own work does not count against the page.
    const tasks = withoutProbes(pageTasks, probes);
    const end = shownAt + AFTER_START_MS;
    return { longest: longestOverlapping(tasks, shownAt, end), blocking: blockingWithin(tasks, shownAt, end), busy };
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

/** How a click to a message went. */
interface SwitchTiming {
    /** Milliseconds from the click to the message being painted. */
    ms: number;
    /** Milliseconds of the longest task overlapping that time or the {@link AFTER_SWITCH_MS} after it; 0 for none. */
    longestTask: number;
    /** Milliseconds from the browser taking the click to the page's first handler for it running. */
    inputDelay: number;
}

/** What {@link timeClickToText} keeps on the page's window while it measures. */
interface ClickWindow extends ReadableWindow, LongTaskWindow {
    aetherBenchClickAt?: number;
    aetherBenchInputDelay?: number;
    aetherBenchShownAt?: number;
    aetherBenchCancel?: () => void;
}

/**
 * Time from a click to `target` being painted readable, measured in the page, and the longest task in that time or
 * soon after. Long tasks come from {@link watchLongTasks}, which must have been set up before the page loaded, as must
 * the readable check; see {@link installReadableCheck}.
 */
async function timeClickToText(page: Page, click: () => Promise<void>, target: ReadableTarget): Promise<SwitchTiming> {
    await page.evaluate((wanted) => {
        const win = window as unknown as ClickWindow;
        // An earlier attempt that failed must not keep watching, or record into this one.
        win.aetherBenchCancel?.();
        win.aetherBenchClickAt = undefined;
        win.aetherBenchInputDelay = undefined;
        win.aetherBenchShownAt = undefined;
        let stopWatching: (() => void) | undefined;
        const onPointerDown = (event: PointerEvent): void => {
            if (win.aetherBenchClickAt !== undefined) return;
            win.aetherBenchClickAt = performance.now();
            // The event's time stamp is when the browser took it, so this is how long it waited for the page.
            win.aetherBenchInputDelay = Math.max(0, win.aetherBenchClickAt - event.timeStamp);
            // Only what is painted after the click counts.
            stopWatching = win.aetherBenchWatchReadable!(wanted, (at) => {
                win.aetherBenchShownAt = at;
                win.aetherBenchCancel?.();
            });
        };
        document.addEventListener("pointerdown", onPointerDown, { capture: true, once: true });
        win.aetherBenchCancel = (): void => {
            stopWatching?.();
            document.removeEventListener("pointerdown", onPointerDown, { capture: true });
        };
    }, target);
    try {
        await click();
        await page.waitForFunction(
            () => (window as unknown as ClickWindow).aetherBenchShownAt !== undefined,
            undefined,
            { timeout: 30_000 },
        );
        // Long tasks are reported once they end, so wait for those still running, or put off, after the message shows.
        await page.waitForTimeout(AFTER_SWITCH_MS);
        const { clickAt, shownAt, inputDelay, pageTasks, probes } = await page.evaluate(() => {
            const win = window as unknown as ClickWindow;
            return {
                clickAt: win.aetherBenchClickAt!,
                shownAt: win.aetherBenchShownAt!,
                inputDelay: win.aetherBenchInputDelay ?? 0,
                pageTasks: win.aetherBenchLongTasksNow?.() ?? [],
                probes: win.aetherBenchProbes ?? [],
            };
        });
        // The readable check's own work does not count against the page.
        const tasks = withoutProbes(pageTasks, probes);
        return {
            ms: Math.round(shownAt - clickAt),
            // A task that began before the click but ran into it held the click up too.
            longestTask: Math.round(longestOverlapping(tasks, clickAt, shownAt + AFTER_SWITCH_MS)),
            inputDelay: Math.round(inputDelay),
        };
    } finally {
        await page.evaluate(() => (window as unknown as ClickWindow).aetherBenchCancel?.());
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
 * {@link timeClickToText} into `samples` under `metric`, with its longest task under `<metric>, longest task` and how
 * long the click waited for the page under `<metric>, input delay`. Toasts
 * are closed first so they cannot block the click. Closing them happens outside the measurement, because clicking a
 * toast would count as the click being timed. A toast that appears during the click blocks it, so the measurement is
 * taken again; the first try already moved there, so its sample is not kept, but counted under
 * `<metric>, measured again`, so that no percentile is read without knowing what was set aside.
 * @param click - Clicks through to the message. Each click must fail rather than wait when it is blocked.
 */
async function measureClick(
    page: Page,
    samples: Samples,
    metric: string,
    click: () => Promise<void>,
    target: ReadableTarget,
): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        await dismissToasts(page);
        try {
            const timing = await timeClickToText(page, click, target);
            if (attempt === 0) {
                add(samples, metric, timing.ms);
                add(samples, `${metric}, longest task`, timing.longestTask);
                add(samples, `${metric}, input delay`, timing.inputDelay);
            } else {
                add(samples, `${metric}, measured again`, 1);
            }
            return;
        } catch (error) {
            if (attempt === 2) throw error;
            console.log(`[benchmark] click blocked, measuring again: ${String(error).split("\n")[0]}`);
        }
    }
}

const CLICK_TIMEOUT = 10_000;

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
            await page.addInitScript(installReadableCheck);
            await watchForText(page, seeded.destination);
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
            add(samples, "fresh: busy after shown", fresh.busy);

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
                add(samples, "warm: busy after shown", warm.busy);
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
                        await measureClick(
                            page,
                            samples,
                            firstVisit ? "server switch: first visit, first channel" : "server switch: visited",
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
                            channel,
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
                await page.waitForFunction(
                    (wanted) => (window as unknown as ReadableWindow).aetherBenchReadable?.(wanted, true) ?? false,
                    reopened,
                    { timeout: 10_000 },
                );
                current = reopened.name;
                for (let run = 0; run < SWITCH_PASSES; run++) {
                    for (const channel of space.channels) {
                        // Clicking the channel already open measures nothing.
                        if (channel.name === current) continue;
                        const metric = opened.has(channel.name)
                            ? "channel switch: visited"
                            : "channel switch: first visit";
                        opened.add(channel.name);
                        current = channel.name;
                        await measureClick(
                            page,
                            samples,
                            metric,
                            () =>
                                page
                                    .getByTestId("room-list")
                                    .locator(`[title="${channel.name}"]`)
                                    .first()
                                    .click({ timeout: CLICK_TIMEOUT }),
                            channel,
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
                switchPasses: SWITCH_PASSES,
                afterSwitchMs: AFTER_SWITCH_MS,
                encrypted: ENCRYPTED,
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
