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

async function readable(page: Page, target: ReadableTarget = TARGET): Promise<boolean> {
    return page.evaluate((wanted) => (window as unknown as ReadableWindow).aetherBenchReadable!(wanted), target);
}

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
});
