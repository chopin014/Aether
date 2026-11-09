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
 * Scroll the room's timeline until `tile` is drawn, first down and then up, then bring it into view. The new
 * timeline only draws the rows near the screen, so a message further away has no element to find until the timeline
 * is scrolled to it; the old timeline draws every loaded message, and this only brings it into view.
 *
 * @param page - the page the room is open in
 * @param tile - the tile to find, which should match one element once it is drawn
 */
export async function scrollTimelineTo(page: Page, tile: Locator): Promise<void> {
    const scroller = timelineScroller(page);
    for (const direction of [1, -1]) {
        while ((await tile.count()) === 0) {
            const moved = await scroller.evaluate((element, step) => {
                const before = element.scrollTop;
                element.scrollTop += step * element.clientHeight * 0.8;
                return element.scrollTop !== before;
            }, direction);
            if (!moved) break;
            // Give the timeline a frame to draw the rows it has scrolled to.
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        }
    }
    await tile.scrollIntoViewIfNeeded();
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
