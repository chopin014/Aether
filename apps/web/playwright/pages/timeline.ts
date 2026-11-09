/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type { Locator, Page } from "@playwright/test";

// The room timeline's parts, as drawn by the old timeline and by the new one (`feature_new_timeline`), so that a
// test runs on either.

/** The element the room's timeline scrolls in. */
export function timelineScroller(page: Page): Locator {
    return page.locator(".mx_RoomView_timeline").locator(".mx_ScrollPanel, [data-testid='timeline-scroller']");
}

/** The list of the room's messages. */
export function messageList(page: Page): Locator {
    return page.locator(".mx_RoomView_timeline").locator(".mx_RoomView_MessageList, .mx_TimelineView_list");
}

/** The room's event tiles drawn in the list itself, rather than inside a summary. */
export function topLevelTiles(page: Page): Locator {
    return page
        .locator(".mx_RoomView_timeline")
        .locator(".mx_RoomView_MessageList > .mx_EventTile, .mx_TimelineView_list > li > .mx_EventTile");
}

/**
 * Scroll the room's timeline until `tile` is drawn, then bring it into view. The new timeline only draws the rows near
 * the screen, so a message further away has no element to find until the timeline is scrolled to it; the old timeline
 * draws every loaded message, and this only brings it into view.
 *
 * The directions are searched in turn, by most of a screen at a time, and again until the time is up: messages can be
 * paged in late, such as while a room's history is still being prepared. At either end the search waits while the
 * timeline is paging or growing before it moves on.
 *
 * @param page - the page the room is open in
 * @param tile - the tile to find, which should match one element once it is drawn
 * @param options.directions - where to look, in order: 1 towards newer messages, -1 towards older ones
 * @param options.timeout - how long the whole search may take, in milliseconds
 */
export async function scrollTimelineTo(
    page: Page,
    tile: Locator,
    { directions = [1, -1], timeout = 10_000 }: { directions?: Array<1 | -1>; timeout?: number } = {},
): Promise<void> {
    const scroller = timelineScroller(page);
    // Either timeline's paging spinners: the new one's loading rows, and the spinner the old one puts in a row of its
    // own at either end. Tiles and galleries have progress bars of their own, such as while a picture loads, deeper
    // inside their rows; those say nothing about paging.
    const paging = scroller
        .locator(".mx_NewTimelinePanel_loading, .mx_RoomView_MessageList > li > .mx_Spinner")
        .getByRole("progressbar");
    const deadline = Date.now() + timeout;
    // Every step waits no longer than the search has left, so a timeline that goes away ends the search on time.
    const timeLeft = (): number => Math.max(1, deadline - Date.now());

    /** Scroll towards one end until the tile is drawn, or the end has been reached and nothing more comes. */
    const searchTowards = async (direction: 1 | -1): Promise<void> => {
        // How many times running the end was reached with nothing new to show.
        let idle = 0;
        while ((await tile.count()) === 0 && Date.now() < deadline && idle < 10) {
            const { moved, height } = await scroller.evaluate(
                (element, step) => {
                    const before = element.scrollTop;
                    element.scrollTop += step * element.clientHeight * 0.8;
                    return { moved: element.scrollTop !== before, height: element.scrollHeight };
                },
                direction,
                { timeout: timeLeft() },
            );
            // Give the timeline a frame to draw the rows it has scrolled to. A hidden page draws no frames, so do not
            // wait for one for long.
            await page.evaluate(
                () =>
                    new Promise((resolve) => {
                        requestAnimationFrame(resolve);
                        setTimeout(resolve, 100);
                    }),
            );
            if (moved) {
                idle = 0;
                continue;
            }
            await page.waitForTimeout(Math.min(100, timeLeft()));
            const grew =
                (await scroller.evaluate((element) => element.scrollHeight, undefined, { timeout: timeLeft() })) !==
                height;
            idle = grew || (await paging.count()) > 0 ? 0 : idle + 1;
        }
    };

    const notFound = (cause?: unknown): Error => {
        const where = directions.map((direction) => (direction > 0 ? "newer" : "older")).join(" then ");
        return new Error(`No ${tile} in the timeline after looking among ${where} messages for ${timeout}ms`, {
            cause,
        });
    };
    for (let pass = 0; (await tile.count()) === 0; pass++) {
        if (Date.now() >= deadline) throw notFound();
        try {
            await searchTowards(directions[pass % directions.length]);
        } catch (error) {
            // A step ran out of time, such as when the timeline went away: report it as the search ending.
            if (error instanceof Error && error.name === "TimeoutError") throw notFound(error);
            throw error;
        }
    }
    await tile.scrollIntoViewIfNeeded({ timeout: Math.max(1_000, deadline - Date.now()) });
}

export class Timeline {
    constructor(private page: Page) {}

    // Scroll to the top of the timeline
    async scrollToTop(): Promise<void> {
        const locator = timelineScroller(this.page);
        await locator.evaluate((node) => {
            while (node.scrollTop > 0) {
                node.scrollTo(0, 0);
            }
        });
    }

    public async scrollToBottom(): Promise<void> {
        await timelineScroller(this.page).evaluate((scrollPanel) => scrollPanel.scrollTo(0, scrollPanel.scrollHeight));
    }

    // Find the event tile matching the given sender & body
    async findEventTile(sender: string, body: string): Promise<Locator | undefined> {
        const locators = await messageList(this.page).locator(".mx_EventTile").all();
        let latestSender: string | undefined;
        for (const locator of locators) {
            const displayName = locator.locator(".mx_DisambiguatedProfile_displayName");
            if (await displayName.count()) {
                latestSender = await displayName.innerText();
            }
            if (latestSender === sender && (await locator.getByTestId("event-tile-slot-body").innerText()) === body) {
                return locator;
            }
        }
    }
}
