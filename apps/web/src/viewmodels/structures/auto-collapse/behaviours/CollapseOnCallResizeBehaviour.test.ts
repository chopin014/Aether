/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import EventEmitter from "node:events";

import { type CallStore, CallStoreEvent } from "../../../../stores/CallStore";
import { CollapseOnCallResizeBehaviour } from "./CollapseOnCallResizeBehaviour";
import { CollapseHandler } from "../CollapseHandler";
import SettingsStore from "../../../../settings/SettingsStore";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.useFakeTimers();

describe("CollapseOnCallResizeBehaviour", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps desktop channel navigation and call controls visible during calls", () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation((setting) => setting === "feature_desktop_shell");
        const store = new EventEmitter() as unknown as CallStore;
        const expand = vi.fn();
        const collapse = vi.fn();
        const behaviour = new CollapseOnCallResizeBehaviour(new CollapseHandler(expand, collapse, 0), store);
        store.emit(CallStoreEvent.ConnectedCalls, new Set([1]));
        store.emit(CallStoreEvent.ConnectedCalls, new Set());
        expect(collapse).not.toHaveBeenCalled();
        expect(expand).not.toHaveBeenCalled();
        expect(behaviour.shouldIgnoreResize).toBe(false);
        behaviour.dispose();
    });

    it("Should collapse/expand the panel on call", () => {
        const mockCallStore = new EventEmitter() as unknown as CallStore;

        const expandPanel = vi.fn();
        const collapsePanel = vi.fn();
        const collapseHandler = new CollapseHandler(expandPanel, collapsePanel, 0);
        new CollapseOnCallResizeBehaviour(collapseHandler, mockCallStore);

        // No calls yet
        expect(expandPanel).not.toHaveBeenCalled();
        expect(collapsePanel).not.toHaveBeenCalled();

        // Let's say we get a call
        mockCallStore.emit(CallStoreEvent.ConnectedCalls, new Set([1]));
        expect(collapsePanel).toHaveBeenCalledTimes(1);

        // When the call is over
        mockCallStore.emit(CallStoreEvent.ConnectedCalls, new Set([]));
        expect(expandPanel).toHaveBeenCalledTimes(1);
    });

    it("should set shouldIgnoreResize to true on call", () => {
        const mockCallStore = new EventEmitter() as unknown as CallStore;

        const expandPanel = vi.fn();
        const collapsePanel = vi.fn();
        const collapseHandler = new CollapseHandler(expandPanel, collapsePanel, 0);
        const behaviour = new CollapseOnCallResizeBehaviour(collapseHandler, mockCallStore);

        // Initially shouldIgnoreResize should be false
        expect(behaviour.shouldIgnoreResize).toBe(false);
        // Let's say we get a call
        mockCallStore.emit(CallStoreEvent.ConnectedCalls, new Set([1]));
        // shouldIgnoreResize becomes true
        expect(behaviour.shouldIgnoreResize).toBe(true);
        // shouldIgnoreResize becomes false after some time
        vi.runAllTimers();
        expect(behaviour.shouldIgnoreResize).toBe(false);
    });
});
