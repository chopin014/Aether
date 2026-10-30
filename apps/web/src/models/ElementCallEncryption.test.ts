/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The pinned engine exposes no Publisher export. Execute its real constructor with media boundaries stubbed.
const bundle = readFileSync(fileURLToPath(import.meta.resolve("@element-hq/element-call-component")), "utf8");
const start = bundle.indexOf("var c3 = class {", bundle.indexOf("src/state/CallViewModel/localMember/Publisher.ts"));
const end = bundle.indexOf("\n\tasync destroy()", start);
const Publisher = runInNewContext(`${bundle.slice(start, end)}\n}; c3;`, {
    yL: class {},
    J: { LocalTrackPublished: "published" },
}) as {
    new (connection: { livekitRoom: unknown }, ...args: unknown[]): unknown;
    prototype: Record<string, unknown>;
};
Object.assign(Publisher.prototype, {
    observeTrackProcessors: vi.fn(),
    observeMediaDevices: vi.fn(),
    workaroundRestartAudioInputTrackChrome: vi.fn(),
    onLocalTrackPublished: vi.fn(),
});

describe("Element Call encrypted publishing", () => {
    it.each([
        { options: { encryption: {} }, encrypted: true },
        { options: { e2ee: {} }, encrypted: true },
        { options: {}, encrypted: false },
    ])("enables encryption from $options", ({ options, encrypted }) => {
        const room = {
            options,
            setE2EEEnabled: vi.fn().mockResolvedValue(undefined),
            localParticipant: { on: vi.fn() },
        };
        new Publisher({ livekitRoom: room }, {}, {}, {}, { error: vi.fn() }, false);
        expect(room.setE2EEEnabled).toHaveBeenCalledExactlyOnceWith(encrypted);
    });
});
