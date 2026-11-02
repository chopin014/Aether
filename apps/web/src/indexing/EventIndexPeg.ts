/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * Object holding the global EventIndex object. Can only be initialized if the
 * platform supports event indexing.
 */

import { logger } from "matrix-js-sdk/src/logger";

import PlatformPeg from "../PlatformPeg";
import EventIndex from "../indexing/EventIndex";
import { MatrixClientPeg } from "../MatrixClientPeg";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";

const INDEX_VERSION = 1;

/**
 * Holds the current instance of the `EventIndex` to use across the codebase.
 * Looking for an `EventIndex`? Just look for the `EventIndexPeg` on the peg
 * board. "Peg" is the literal meaning of something you hang something on. So
 * you'll find a `EventIndex` hanging on the `EventIndexPeg`.
 */
export class EventIndexPeg {
    public index: EventIndex | null = null;
    public error: unknown;

    private _supportIsInstalled = false;
    /** An index started by {@link initInBackground} that has not finished opening yet. */
    private pending?: { index: EventIndex; cancelled: boolean; opening: boolean };
    /** The index being opened right now, however that was started. */
    private opening?: { cancelled: boolean; result: Promise<boolean> };

    /**
     * Initialize the EventIndexPeg and if event indexing is enabled initialize
     * the event index.
     *
     * @returns {Promise<boolean>} A promise that will resolve to true if an
     * EventIndex was successfully initialized, false otherwise.
     */
    public async init(): Promise<boolean> {
        if (!(await this.canIndex())) return false;
        return this.initEventIndex();
    }

    /**
     * Initialize the event index without holding up startup. It starts hearing live events straight away, so none
     * are missed, but the index itself is only opened once `openWhen` settles. Opening it takes a while, and on
     * desktop it keeps the host process busy meanwhile, which would otherwise delay everything else loading.
     *
     * @param openWhen - Settles when the app is ready for the index to be opened, such as once the chats are shown.
     * @returns A promise that resolves to true if an EventIndex was successfully initialized, false otherwise.
     */
    public initInBackground(openWhen: Promise<unknown>): Promise<boolean> {
        if (!PlatformPeg.get()?.getEventIndexingManager()) return this.init();
        const index = new EventIndex();
        index.listenBeforeOpening();
        const pending: NonNullable<EventIndexPeg["pending"]> = { index, cancelled: false, opening: false };
        this.pending = pending;
        return this.openInBackground(pending, openWhen);
    }

    private async openInBackground(
        pending: NonNullable<EventIndexPeg["pending"]>,
        openWhen: Promise<unknown>,
    ): Promise<boolean> {
        const { index } = pending;
        const client = MatrixClientPeg.get();
        // Logging out, or deleting the index, while this waits must not open it afterwards for the wrong account.
        const stillWanted = (): boolean => !pending.cancelled && MatrixClientPeg.get() === client;
        try {
            if (!(await this.canIndex()) || !stillWanted()) {
                index.abandon();
                return false;
            }
            await openWhen;
            if (!stillWanted()) {
                index.abandon();
                return false;
            }
            pending.opening = true;
            const opened = await this.initEventIndex(index);
            if (opened && !stillWanted()) {
                // Only close what this attempt published: if it gave way to a direct opening, that index is not ours.
                if (this.index === index) {
                    await index.close();
                    this.index = null;
                }
                return false;
            }
            return opened;
        } catch (e) {
            index.abandon();
            throw e;
        } finally {
            if (this.pending === pending) this.pending = undefined;
        }
    }

    /** Whether this platform can index events and the person wants it to. */
    private async canIndex(): Promise<boolean> {
        const indexManager = PlatformPeg.get()?.getEventIndexingManager();
        if (!indexManager) {
            logger.log("EventIndex: Platform doesn't support event indexing, not initializing.");
            return false;
        }

        this._supportIsInstalled = await indexManager.supportsEventIndexing();

        if (!this.supportIsInstalled()) {
            logger.log("EventIndex: Event indexing isn't installed for the platform, not initializing.");
            return false;
        }

        const enableEventIndexing = SettingsStore.getValueAt(SettingLevel.DEVICE, "enableEventIndexing");
        if (!enableEventIndexing) {
            logger.log("EventIndex: Event indexing is disabled, not initializing");
            return false;
        }
        return true;
    }

    /**
     * Initialize the event index.
     *
     * @param index - The index to open, if one is already listening for live events.
     * @returns {boolean} True if the event index was successfully initialized,
     * false otherwise.
     */
    public initEventIndex(index?: EventIndex): Promise<boolean> {
        if (index && this.opening) {
            // A direct opening got there first; the background one gives way to it.
            index.abandon();
            return this.opening.result;
        }
        if (!index) {
            // Asked for directly, e.g. after turning indexing on: reuse an attempt already under way rather than open a
            // second index, and take over from one that is still waiting for startup to settle.
            if (this.opening) return this.opening.result;
            const waiting = this.pending;
            if (waiting && !waiting.opening) {
                waiting.cancelled = true;
                waiting.index.abandon();
                this.pending = undefined;
            }
        }
        const attempt: { cancelled: boolean; result: Promise<boolean> } = {
            cancelled: false,
            result: Promise.resolve(false),
        };
        attempt.result = this.openIndex(index ?? new EventIndex(), attempt).finally(() => {
            if (this.opening === attempt) this.opening = undefined;
        });
        this.opening = attempt;
        return attempt.result;
    }

    private async openIndex(index: EventIndex, attempt: { cancelled: boolean }): Promise<boolean> {
        const indexManager = PlatformPeg.get()?.getEventIndexingManager();
        const client = MatrixClientPeg.get();
        if (!indexManager || !client) {
            index.abandon();
            throw new Error("Unable to init event index");
        }

        const userId = client.getUserId()!;
        const deviceId = client.getDeviceId()!;
        const tokenizerMode = SettingsStore.getValueAt(SettingLevel.DEVICE, "tokenizerMode");

        try {
            const initResult = await indexManager.initEventIndex(userId, deviceId, tokenizerMode);

            // If the database was recreated (e.g., due to schema change), force re-adding checkpoints
            if (initResult && typeof initResult === "object" && initResult.wasRecreated) {
                logger.log("EventIndex: Database was recreated, will force add initial checkpoints");
                index.setForceAddInitialCheckpoints(true);
            }

            const userVersion = await indexManager.getUserVersion();
            const eventIndexIsEmpty = await indexManager.isEventIndexEmpty();

            if (eventIndexIsEmpty) {
                await indexManager.setUserVersion(INDEX_VERSION);
                // Force adding initial checkpoints because limited timeline events
                // may add checkpoints before onSync is called
                logger.log("EventIndex: Index is empty, will force add initial checkpoints");
                index.setForceAddInitialCheckpoints(true);
            } else if (userVersion === 0 && !eventIndexIsEmpty) {
                // Not deleteEventIndex(): that waits for opening to finish, and this is part of opening.
                await indexManager.closeEventIndex();
                logger.log("EventIndex: Deleting event index.");
                await indexManager.deleteEventIndex();

                await indexManager.initEventIndex(userId, deviceId, tokenizerMode);
                await indexManager.setUserVersion(INDEX_VERSION);
            }

            logger.log("EventIndex: Successfully initialized the event index");
            await index.init();
        } catch (e) {
            logger.log("EventIndex: Error initializing the event index", e);
            this.error = e;
            index.abandon();
            return false;
        }

        if (attempt.cancelled) {
            // Signed out, or the index was deleted, while it was opening.
            await index.close();
            return false;
        }
        this.index = index;

        return true;
    }

    /**
     * Check if the current platform has support for event indexing.
     *
     * @returns {boolean} True if it has support, false otherwise. Note that this
     * does not mean that support is installed.
     */
    public platformHasSupport(): boolean {
        return PlatformPeg.get()?.getEventIndexingManager() != null;
    }

    /**
     * Check if event indexing support is installed for the platform.
     *
     * Event indexing might require additional optional modules to be installed,
     * this tells us if those are installed. Note that this should only be
     * called after the init() method was called.
     *
     * @returns {boolean} True if support is installed, false otherwise.
     */
    public supportIsInstalled(): boolean {
        return this._supportIsInstalled;
    }

    /**
     * Get the current event index.
     *
     * @returns {EventIndex} The current event index.
     */
    public get(): EventIndex | null {
        return this.index;
    }

    public start(): void {
        if (this.index === null) return;
        this.index.startCrawler();
    }

    public stop(): void {
        if (this.index === null) return;
        this.index.stopCrawler();
    }

    /**
     * Unset our event store
     *
     * After a call to this the init() method will need to be called again.
     *
     * @returns {Promise} A promise that will resolve once the event index is
     * closed.
     */
    public async unset(): Promise<void> {
        const pending = this.pending;
        if (pending) {
            pending.cancelled = true;
            this.pending = undefined;
            if (!pending.opening) pending.index.abandon();
        }
        // Once the database is being opened, wait for that attempt to finish and clean up after itself, so it cannot
        // close or write to whatever replaces it.
        const opening = this.opening;
        if (opening) {
            opening.cancelled = true;
            await opening.result.catch(() => {});
        }
        if (this.index === null) return;
        await this.index.close();
        this.index = null;
    }

    /**
     * Delete our event indexer.
     *
     * After a call to this the init() method will need to be called again.
     *
     * @returns {Promise} A promise that will resolve once the event index is
     * deleted.
     */
    public async deleteEventIndex(): Promise<void> {
        const indexManager = PlatformPeg.get()?.getEventIndexingManager();

        if (indexManager) {
            await this.unset();
            logger.log("EventIndex: Deleting event index.");
            await indexManager.deleteEventIndex();
        }
    }
}

if (!window.mxEventIndexPeg) {
    window.mxEventIndexPeg = new EventIndexPeg();
}
export default window.mxEventIndexPeg;
