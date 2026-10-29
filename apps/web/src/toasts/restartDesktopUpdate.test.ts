/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "vitest-canvas-mock";

import Modal, { type IHandle } from "../Modal";
import PlatformPeg from "../PlatformPeg";
import type BasePlatform from "../BasePlatform";
import QuestionDialog from "../components/views/dialogs/QuestionDialog";
import { restartDesktopUpdate } from "./restartDesktopUpdate";

const { callStore } = vi.hoisted(() => ({ callStore: { connectedCalls: new Set<unknown>() } }));

vi.mock("../stores/CallStore", () => ({
    CallStore: {
        get instance() {
            return callStore;
        },
    },
}));

describe("restartDesktopUpdate", () => {
    const installUpdate = vi.fn();

    beforeEach(() => {
        callStore.connectedCalls.clear();
        installUpdate.mockReset();
        vi.spyOn(PlatformPeg, "get").mockReturnValue({ installUpdate } as unknown as BasePlatform);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("restarts immediately when no call is active", () => {
        const createDialog = vi.spyOn(Modal, "createDialog");

        restartDesktopUpdate();

        expect(installUpdate).toHaveBeenCalledOnce();
        expect(createDialog).not.toHaveBeenCalled();
    });

    it("waits for confirmation before restarting during an active call", async () => {
        callStore.connectedCalls.add({});
        const handle = {
            close: vi.fn(),
            finished: Promise.resolve([true] as [boolean]),
        } satisfies IHandle<typeof QuestionDialog>;
        const createDialog = vi.spyOn(Modal, "createDialog").mockReturnValue(handle);

        restartDesktopUpdate();
        expect(createDialog).toHaveBeenCalledWith(
            QuestionDialog,
            expect.objectContaining({
                title: "Restart Aether while in a call?",
                button: "Restart now",
                danger: true,
            }),
        );
        expect(installUpdate).not.toHaveBeenCalled();

        await Promise.resolve();

        expect(installUpdate).toHaveBeenCalledOnce();
    });

    it("does not restart if the user declines the active call confirmation", async () => {
        callStore.connectedCalls.add({});
        const handle = {
            close: vi.fn(),
            finished: Promise.resolve([false] as [boolean]),
        } satisfies IHandle<typeof QuestionDialog>;
        vi.spyOn(Modal, "createDialog").mockReturnValue(handle);

        restartDesktopUpdate();
        await Promise.resolve();

        expect(installUpdate).not.toHaveBeenCalled();
    });
});
