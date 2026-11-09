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
    // The search leaves itself time to bring a tile it finds into view, so the whole call ends within the timeout.
    const searchDeadline = deadline - Math.min(1_000, timeout / 10);

    const notFound = (cause?: unknown): Error => {
        const where = directions.map((direction) => (direction > 0 ? "newer" : "older")).join(" then ");
        return new Error(`No ${tile} in the timeline after looking among ${where} messages for ${timeout}ms`, {
            cause,
        });
    };

    /**
     * Wait for one step of the search, but no later than `until`, however the step itself waits: a page that has
     * stopped answering, or stopped drawing frames, ends the search on time rather than holding it.
     */
    const step = <T>(work: Promise<T>, until = searchDeadline): Promise<T> => {
        // A step given up on may still fail later; nothing waits on it then.
        work.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeUp = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(notFound()), Math.max(0, until - Date.now()));
        });
        return Promise.race([work, timeUp]).finally(() => clearTimeout(timer));
    };

    /** Scroll towards one end until the tile is drawn, or the end has been reached and nothing more comes. */
    const searchTowards = async (direction: 1 | -1): Promise<void> => {
        // How many times running the end was reached with nothing new to show.
        let idle = 0;
        while ((await step(tile.count())) === 0 && Date.now() < searchDeadline && idle < 10) {
            const { moved, height } = await step(
                scroller.evaluate((element, by) => {
                    const before = element.scrollTop;
                    element.scrollTop += by * element.clientHeight * 0.8;
                    return { moved: element.scrollTop !== before, height: element.scrollHeight };
                }, direction),
            );
            // Give the timeline a frame to draw the rows it has scrolled to. A hidden page draws no frames, so do not
            // wait for one for long.
            await step(
                page.evaluate(
                    () =>
                        new Promise((resolve) => {
                            requestAnimationFrame(resolve);
                            setTimeout(resolve, 100);
                        }),
                ),
            );
            if (moved) {
                idle = 0;
                continue;
            }
            await step(page.waitForTimeout(100));
            const grew = (await step(scroller.evaluate((element) => element.scrollHeight))) !== height;
            idle = grew || (await step(paging.count())) > 0 ? 0 : idle + 1;
        }
    };

    try {
        for (let pass = 0; (await step(tile.count())) === 0; pass++) {
            if (Date.now() >= searchDeadline) throw notFound();
            await searchTowards(directions[pass % directions.length]);
        }
    } catch (error) {
        // A Playwright step that timed out, such as when the timeline went away, also ends the search.
        if (error instanceof Error && error.name === "TimeoutError") throw notFound(error);
        throw error;
    }
    const left = Math.max(1, deadline - Date.now());
    await step(tile.scrollIntoViewIfNeeded({ timeout: left }), deadline);
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
