/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// What the navigation benchmark counts as a message being readable, checked against small pages built for it: no app
// or homeserver is needed.
import { expect, type Page, test } from "@playwright/test";

import { installReadableCheck, type ReadableTarget, type ReadableWindow } from "./readableTimeline";

const ROOM = "!room:example.org";
const TARGET: ReadableTarget = { roomId: ROOM, eventId: "$target", text: "the wanted message" };

/** A row for `eventId` with `text`, as the timeline draws one. */
const row = (eventId: string, text: string, style = ""): string =>
    `<div class="row" data-event-id="${eventId}" style="${style}"><span class="mx_EventTile_body">${text}</span></div>`;

/** A room's main timeline holding `rows`, in a scroller 200 px high. */
const timeline = (rows: string, roomId = ROOM, mainAttributes = ""): string =>
    `<main data-room-id="${roomId}" ${mainAttributes}><div class="scroller">${rows}</div></main>`;

async function show(page: Page, body: string): Promise<void> {
    await page.setContent(`<!doctype html>
        <style>
            body { margin: 0; font: 16px/20px sans-serif; }
            .scroller { position: relative; height: 200px; width: 400px; overflow: auto; }
            .row { min-height: 20px; }
        </style>
        <body>${body}</body>`);
    await page.evaluate(installReadableCheck);
}

async function readable(page: Page, target: ReadableTarget = TARGET, thorough = false): Promise<boolean> {
    return page.evaluate(
        ({ wanted, thorough }) => (window as unknown as ReadableWindow).aetherBenchReadable!(wanted, thorough),
        { wanted: target, thorough },
    );
}

/** The target event's row, holding `body` as its message body. */
const rowWithBody = (body: string, bodyStyle = ""): string =>
    `<div class="row" data-event-id="$target"><span class="mx_EventTile_body" style="${bodyStyle}">${body}</span></div>`;

test.describe("readable timeline check", () => {
    test("reads the target message in view in its room's main timeline", async ({ page }) => {
        await show(page, timeline(row("$before", "an earlier message") + row("$target", "the wanted message")));
        expect(await readable(page)).toBe(true);
    });

    test("only counts the target event in the target room", async ({ page }) => {
        await show(
            page,
            timeline(row("$target", "the wanted message"), "!other:example.org") +
                timeline(row("$other", "the wanted message")),
        );
        expect(await readable(page)).toBe(false);
        expect(await readable(page, { ...TARGET, roomId: "!other:example.org" })).toBe(true);
        expect(await readable(page, { ...TARGET, eventId: "$other" })).toBe(true);
    });

    for (const [name, wrap] of [
        ["hidden", (rows: string) => `<div hidden>${rows}</div>`],
        ["inert", (rows: string) => `<div inert>${rows}</div>`],
        ["hidden from assistive technology", (rows: string) => `<div aria-hidden="true">${rows}</div>`],
        ["not displayed", (rows: string) => `<div style="display: none">${rows}</div>`],
        ["invisible", (rows: string) => `<div style="visibility: hidden">${rows}</div>`],
        ["transparent", (rows: string) => `<div style="opacity: 0">${rows}</div>`],
    ] as const) {
        test(`does not count a ${name} copy`, async ({ page }) => {
            await show(page, timeline(wrap(row("$target", "the wanted message"))));
            expect(await readable(page)).toBe(false);
        });
    }

    test("does not count a copy outside the main timeline, such as in the right panel or search results", async ({
        page,
    }) => {
        await show(
            page,
            `<aside><div class="scroller">${row("$target", "the wanted message")}</div></aside>` +
                timeline(`<div class="mx_RoomView_searchResultsPanel">${row("$target", "the wanted message")}</div>`),
        );
        expect(await readable(page)).toBe(false);
    });

    test("does not count text scrolled out of the timeline's view until it is scrolled in", async ({ page }) => {
        await show(page, timeline(`<div style="height: 500px"></div>` + row("$target", "the wanted message")));
        expect(await readable(page)).toBe(false);

        await page.evaluate(() => document.querySelector(".scroller")!.scrollTo(0, 1000));
        expect(await readable(page)).toBe(true);
    });

    test("does not count a line only partly in view", async ({ page }) => {
        // The line spans 190 to 210 px of a 200 px scroller.
        await show(page, timeline(`<div style="height: 190px"></div>` + row("$target", "the wanted message")));
        expect(await readable(page)).toBe(false);
    });

    test("does not count a tall message whose box is in view while the wanted text is not", async ({ page }) => {
        const tall = `<div style="height: 300px">the start of a long message</div>the wanted message`;
        await show(page, timeline(row("$target", tall)));
        expect(await readable(page)).toBe(false);
    });

    test("does not count a message something else covers", async ({ page }) => {
        const cover = `<div style="position: absolute; inset: 0; background: white"></div>`;
        await show(page, timeline(row("$target", "the wanted message") + cover));
        expect(await readable(page)).toBe(false);
    });

    test("does not count text its own element clips", async ({ page }) => {
        await show(page, timeline(rowWithBody("the wanted message", "display: block; height: 5px; overflow: hidden")));
        expect(await readable(page)).toBe(false);
    });

    test("does not count text under the timeline's scrollbar", async ({ page }) => {
        await show(page, timeline(rowWithBody("the wanted message", "white-space: nowrap")));
        // Move the line along until it ends in the middle of the vertical scrollbar.
        const gutter = await page.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>(".scroller")!;
            scroller.style.overflowY = "scroll";
            scroller.style.overflowX = "hidden";
            const gutter = scroller.offsetWidth - scroller.clientWidth - 2 * scroller.clientLeft;
            const body = scroller.querySelector<HTMLElement>(".mx_EventTile_body")!;
            const range = document.createRange();
            range.selectNodeContents(body);
            const line = range.getBoundingClientRect();
            const contentEnd = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
            body.style.marginLeft = `${contentEnd + gutter / 2 - line.right}px`;
            return gutter;
        });
        test.skip(gutter < 4, "Scrollbars overlay the content in this browser, so nothing is under one.");

        expect(await readable(page)).toBe(false);
    });

    test("does not count text under the timeline's border", async ({ page }) => {
        await show(page, timeline(rowWithBody("the wanted message", "white-space: nowrap")));
        // A thick right border, with the line moved along until it ends inside it: in the timeline's box, but not in
        // the part of it that shows content.
        await page.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>(".scroller")!;
            scroller.style.borderRight = "20px solid black";
            scroller.style.overflowX = "hidden";
            const body = scroller.querySelector<HTMLElement>(".mx_EventTile_body")!;
            const range = document.createRange();
            range.selectNodeContents(body);
            const line = range.getBoundingClientRect();
            const contentEnd = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
            body.style.marginLeft = `${contentEnd + 10 - line.right}px`;
        });

        expect(await readable(page)).toBe(false);
    });

    test("does not count text an element inside it covers", async ({ page }) => {
        const cover = `<span style="position: absolute; inset: 0; background: white"></span>`;
        await show(page, timeline(rowWithBody(`the wanted message${cover}`, "position: relative")));
        expect(await readable(page)).toBe(false);
    });

    test("counts a cover the pointer passes through only when asked to be thorough", async ({ page }) => {
        const cover = `<div style="position: absolute; inset: 0; background: white; pointer-events: none"></div>`;
        await show(page, timeline(row("$target", "the wanted message") + cover));
        // The quick check sees through it, as the browser's hit testing does; the benchmark confirms thoroughly.
        expect(await readable(page)).toBe(true);
        expect(await readable(page, TARGET, true)).toBe(false);
    });

    test("reads text under a transparent layer the pointer passes through, as the timeline's floating buttons sit in", async ({
        page,
    }) => {
        const layer = `<div style="position: absolute; inset: 0; z-index: 1000; pointer-events: none"></div>`;
        await show(page, timeline(row("$target", "the wanted message") + layer));
        expect(await readable(page)).toBe(true);
        expect(await readable(page, TARGET, true)).toBe(true);
    });

    test("reads text under a canvas the pointer passes through, as the room's chat effects draw on", async ({
        page,
    }) => {
        const canvas = `<canvas style="position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none"></canvas>`;
        await show(page, timeline(row("$target", "the wanted message") + canvas));
        expect(await readable(page, TARGET, true)).toBe(true);
    });

    for (const attribute of ["inert", 'aria-hidden="true"', "hidden"]) {
        test(`does not count text inside the row marked ${attribute}`, async ({ page }) => {
            await show(page, timeline(rowWithBody(`<span ${attribute}>the wanted message</span>`)));
            expect(await readable(page)).toBe(false);
        });
    }

    test("reads text that runs across nested elements, past a hidden copy before it", async ({ page }) => {
        await show(
            page,
            timeline(rowWithBody(`<span hidden>the wanted message</span>the <b>wanted</b> <i>message</i>`)),
        );
        expect(await readable(page)).toBe(true);
        expect(await readable(page, TARGET, true)).toBe(true);
    });

    test("does not count text running across elements when an element inside clips part of it", async ({ page }) => {
        await show(
            page,
            timeline(
                rowWithBody(
                    `<span style="display: inline-block; width: 2px; overflow: hidden">the wanted</span> message`,
                ),
            ),
        );
        expect(await readable(page)).toBe(false);
        expect(await readable(page, TARGET, true)).toBe(false);
    });

    test("does not count text with a part sized to nothing", async ({ page }) => {
        await show(page, timeline(rowWithBody(`the <b style="font-size: 0">wanted</b> message`)));
        expect(await readable(page)).toBe(false);
    });

    test("reads text in an inline element set to clip, as overflow does not apply to inline boxes", async ({
        page,
    }) => {
        await show(page, timeline(rowWithBody(`<span style="overflow: hidden">the wanted message</span>`)));
        expect(await readable(page)).toBe(true);
    });

    test("does not count text outside an element with paint containment", async ({ page }) => {
        await show(page, timeline(rowWithBody("the wanted message", "display: block; height: 5px; contain: paint")));
        expect(await readable(page)).toBe(false);
    });

    test("does not count a message a transparent element's pseudo-element covers", async ({ page }) => {
        const cover = `<style>.cover::before { content: ""; position: absolute; inset: 0; background: white; }</style>
            <div class="cover" style="position: absolute; inset: 0"></div>`;
        await show(page, timeline(row("$target", "the wanted message") + cover));
        expect(await readable(page)).toBe(false);
        expect(await readable(page, TARGET, true)).toBe(false);
    });

    test("does not count text a pseudo-element of its own element covers", async ({ page }) => {
        const style = `<style>.mx_EventTile_body::after { content: ""; position: absolute; inset: 0; background: white; }</style>`;
        await show(page, style + timeline(rowWithBody("the wanted message", "position: relative")));
        expect(await readable(page)).toBe(false);
        expect(await readable(page, TARGET, true)).toBe(false);
    });

    test("reads text beside its element's own pseudo-element, or over one positioned behind it", async ({ page }) => {
        const style = `<style>
            .mx_EventTile_body::before { content: "•"; background: yellow; }
            .mx_EventTile_body::after { content: ""; position: absolute; inset: 0; z-index: -1; background: yellow; }
        </style>`;
        await show(page, style + timeline(rowWithBody("the wanted message", "position: relative")));
        expect(await readable(page)).toBe(true);
        expect(await readable(page, TARGET, true)).toBe(true);
    });

    test("reads text beside a box its own element positions absolutely", async ({ page }) => {
        const style = `<style>
            .mx_EventTile_body::before {
                content: ""; position: absolute; left: -30px; top: 0; width: 20px; height: 20px; background: red;
            }
        </style>`;
        await show(page, style + timeline(rowWithBody("the wanted message", "position: relative; margin-left: 40px")));
        expect(await readable(page)).toBe(true);
        expect(await readable(page, TARGET, true)).toBe(true);
    });

    test("reads a single character beside a box its own element positions absolutely", async ({ page }) => {
        const style = `<style>
            .mx_EventTile_body::after {
                content: ""; position: absolute; left: -30px; top: 0; width: 20px; height: 20px; background: white;
            }
        </style>`;
        await show(page, style + timeline(rowWithBody("x", "position: relative; margin-left: 40px")));
        const x = { ...TARGET, text: "x" };
        expect(await readable(page, x)).toBe(true);
        expect(await readable(page, x, true)).toBe(true);
    });

    for (const pseudo of ["::before", "::after"]) {
        test(`does not count a single character its own element's ${pseudo} box covers`, async ({ page }) => {
            const style = `<style>
                .mx_EventTile_body${pseudo} { content: ""; position: absolute; inset: 0; background: white; }
            </style>`;
            await show(page, style + timeline(rowWithBody("x", "position: relative")));
            const x = { ...TARGET, text: "x" };
            expect(await readable(page, x)).toBe(false);
            expect(await readable(page, x, true)).toBe(false);
        });
    }

    for (const [name, cover] of [
        ["transparent", `<div style="position: absolute; inset: 0; background: white; opacity: 0"></div>`],
        [
            "inside a transparent element",
            `<div style="opacity: 0"><div style="position: absolute; inset: 0; background: white"></div></div>`,
        ],
        [
            "filtered to nothing",
            `<div style="position: absolute; inset: 0; background: white; filter: opacity(0)"></div>`,
        ],
        ["a transparent image", `<img style="position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0">`],
        [
            "coloured transparent in a modern syntax",
            `<div style="position: absolute; inset: 0; background: oklch(50% 0.2 40 / 0)"></div>`,
        ],
    ] as const) {
        test(`reads a message under a cover that is ${name}`, async ({ page }) => {
            await show(page, timeline(row("$target", "the wanted message") + cover));
            expect(await readable(page)).toBe(true);
            expect(await readable(page, TARGET, true)).toBe(true);
        });
    }

    test("does not count a message under an opaque cover coloured in a modern syntax", async ({ page }) => {
        const cover = `<div style="position: absolute; inset: 0; background: oklch(50% 0.2 40 / 1)"></div>`;
        await show(page, timeline(row("$target", "the wanted message") + cover));
        expect(await readable(page)).toBe(false);
    });

    test("does not count a message under an image", async ({ page }) => {
        const cover = `<img style="position: absolute; inset: 0; width: 100%; height: 100%">`;
        await show(page, timeline(row("$target", "the wanted message") + cover));
        expect(await readable(page)).toBe(false);
    });

    test("leaves the page's styles as they were after a thorough check", async ({ page }) => {
        await show(page, timeline(row("$target", "the wanted message")));
        const before = await page.evaluate(() => document.styleSheets.length);
        expect(await readable(page, TARGET, true)).toBe(true);
        expect(await page.evaluate(() => document.styleSheets.length)).toBe(before);
    });
});

/** What the watching tests keep on the page's window. */
interface WatchWindow extends ReadableWindow {
    readableAt?: number;
    /** When the frame after the one that first painted the added target started. */
    nextFrameAt?: number;
    stopWatching?: () => void;
    inFrame?: boolean;
    checks?: number;
    checksInFrames?: number;
    /** Set to stop what a test does on every frame. */
    settled?: boolean;
}

/** Start watching for `target`, keeping when it was found readable on the window. */
async function watch(page: Page, target: ReadableTarget = TARGET): Promise<void> {
    await page.evaluate((wanted) => {
        const win = window as unknown as WatchWindow;
        win.stopWatching = win.aetherBenchWatchReadable!(wanted, (at) => {
            win.readableAt = at;
        });
    }, target);
}

/** Wait for `count` frames to be painted. */
async function frames(page: Page, count: number): Promise<void> {
    await page.evaluate(async (count) => {
        for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    }, count);
}

async function readableAt(page: Page): Promise<number | undefined> {
    return page.evaluate(() => (window as unknown as WatchWindow).readableAt);
}

/** Add the target's row to the timeline, keeping when the frame after the one that paints it starts on the window. */
async function addTarget(page: Page): Promise<void> {
    await page.evaluate(
        (html) => {
            document.querySelector(".scroller")!.insertAdjacentHTML("beforeend", html);
            // A frame's callbacks are all given the time it started.
            requestAnimationFrame(() =>
                requestAnimationFrame((time) => {
                    (window as unknown as WatchWindow).nextFrameAt = time;
                }),
            );
        },
        row("$target", "the wanted message"),
    );
}

/**
 * Take the target out of sight in a callback of every frame, so every frame is painted without it, and put it back
 * just after each frame is painted, until the window is marked settled.
 * @param how - Whether it is hidden, or its timeline scrolled away from it.
 */
async function outOfSightWhenPainted(page: Page, how: "hidden" | "scrolled away"): Promise<void> {
    await page.evaluate((how) => {
        const win = window as unknown as WatchWindow & {
            scheduler: { postTask: (task: () => void, options: { priority: string }) => Promise<unknown> };
        };
        const body = document.querySelector<HTMLElement>(".mx_EventTile_body")!;
        const scroller = document.querySelector<HTMLElement>(".scroller")!;
        const inSight = (shown: boolean): void => {
            if (how === "hidden") body.style.visibility = shown ? "" : "hidden";
            else scroller.scrollTop = shown ? 1000 : 0;
        };
        const onFrame = (): void => {
            if (win.settled) return;
            inSight(false);
            // Posted ahead of the watcher's check, so it runs first, before anything else after the paint.
            void win.scheduler.postTask(() => inSight(true), { priority: "user-blocking" });
            requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
    }, how);
}

test.describe("watching for readable text", () => {
    test("reports the start of the frame after the one that first painted the message readable", async ({ page }) => {
        await show(page, timeline(row("$before", "an earlier message")));
        await watch(page);
        await frames(page, 3);
        expect(await readableAt(page)).toBeUndefined();

        await addTarget(page);
        await page.waitForFunction(() => (window as unknown as WatchWindow).readableAt !== undefined);
        const { at, nextFrameAt } = await page.evaluate(() => {
            const win = window as unknown as WatchWindow;
            return { at: win.readableAt!, nextFrameAt: win.nextFrameAt! };
        });
        // Taken within that next frame, so no earlier than its start, allowing for the browser coarsening its clock.
        expect(at).toBeGreaterThan(nextFrameAt - 1);
    });

    test("does not report a message hidden whenever a frame is painted, and shown between frames", async ({ page }) => {
        await show(page, timeline(row("$target", "the wanted message")));
        await outOfSightWhenPainted(page, "hidden");
        await watch(page);
        await frames(page, 10);
        expect(await readableAt(page)).toBeUndefined();

        await page.evaluate(() => ((window as unknown as WatchWindow).settled = true));
        await page.waitForFunction(() => (window as unknown as WatchWindow).readableAt !== undefined);
    });

    test("does not report a message scrolled away whenever a frame is painted, and back between frames", async ({
        page,
    }) => {
        await show(page, timeline(`<div style="height: 500px"></div>` + row("$target", "the wanted message")));
        await page.evaluate(() => document.querySelector(".scroller")!.scrollTo(0, 1000));
        await outOfSightWhenPainted(page, "scrolled away");
        await watch(page);
        await frames(page, 10);
        expect(await readableAt(page)).toBeUndefined();

        await page.evaluate(() => ((window as unknown as WatchWindow).settled = true));
        await page.waitForFunction(() => (window as unknown as WatchWindow).readableAt !== undefined);
    });

    test("does not report a message painted readable in only one frame", async ({ page }) => {
        await show(page, timeline(rowWithBody("the wanted message", "visibility: hidden")));
        await watch(page);
        await frames(page, 3);
        // Shown for one frame, and hidden again in the next.
        await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(".mx_EventTile_body")!;
            requestAnimationFrame(() => {
                body.style.visibility = "visible";
                requestAnimationFrame(() => {
                    body.style.visibility = "hidden";
                });
            });
        });
        await frames(page, 10);
        expect(await readableAt(page)).toBeUndefined();
    });

    test("does not report a message under a cover the pointer passes through until it is gone", async ({ page }) => {
        const cover = `<div class="cover" style="position: absolute; inset: 0; background: white; pointer-events: none"></div>`;
        await show(page, timeline(row("$target", "the wanted message") + cover));
        await watch(page);
        await frames(page, 6);
        expect(await readableAt(page)).toBeUndefined();

        await page.evaluate(() => document.querySelector(".cover")!.remove());
        await page.waitForFunction(() => (window as unknown as WatchWindow).readableAt !== undefined);
    });

    test("reports nothing once stopped", async ({ page }) => {
        await show(page, timeline(row("$before", "an earlier message")));
        await watch(page);
        await page.evaluate(() => (window as unknown as WatchWindow).stopWatching!());
        await addTarget(page);
        await frames(page, 6);
        expect(await readableAt(page)).toBeUndefined();
    });

    test("checks outside the app's frames, so it never lengthens them", async ({ page }) => {
        await show(page, timeline(row("$before", "an earlier message")));
        // Note every check made while a frame's callbacks run: those for animation frames, and for resize observers,
        // which run after layout.
        await page.evaluate(() => {
            const win = window as unknown as WatchWindow;
            win.checks = 0;
            win.checksInFrames = 0;
            const inFrame = <T extends unknown[]>(callback: (...args: T) => void, ...args: T): void => {
                win.inFrame = true;
                try {
                    callback(...args);
                } finally {
                    win.inFrame = false;
                }
            };
            const request = window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame = (callback) => request((time) => inFrame(callback, time));
            const Observer = window.ResizeObserver;
            window.ResizeObserver = class extends Observer {
                public constructor(callback: ResizeObserverCallback) {
                    super((entries, observer) => inFrame(callback, entries, observer));
                }
            };
            const rects = Range.prototype.getClientRects;
            Range.prototype.getClientRects = function (this: Range): DOMRectList {
                win.checks = (win.checks ?? 0) + 1;
                if (win.inFrame) win.checksInFrames = (win.checksInFrames ?? 0) + 1;
                return rects.call(this);
            };
        });
        await watch(page);
        await frames(page, 3);
        await addTarget(page);
        await page.waitForFunction(() => (window as unknown as WatchWindow).readableAt !== undefined);

        const { checks, checksInFrames } = await page.evaluate(() => {
            const win = window as unknown as WatchWindow;
            return { checks: win.checks!, checksInFrames: win.checksInFrames! };
        });
        expect(checks).toBeGreaterThan(0);
        expect(checksInFrames).toBe(0);
    });
});
