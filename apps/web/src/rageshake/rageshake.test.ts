/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "./rageshake";

describe("ConsoleLogger", () => {
    it("bounds memory without disk flushes while retaining recent diagnostics", () => {
        const logger = new ConsoleLogger();
        logger.log("I", "oldest message");
        const chunk = "x".repeat(64 * 1024);
        for (let i = 0; i < 40; i++) logger.log("I", chunk);
        logger.log("E", "latest message");

        const logs = logger.flush(true);
        expect(logs.length).toBeLessThanOrEqual(1024 * 1024);
        expect(logs).not.toContain("oldest message");
        expect(logs).toContain("latest message");
        expect(logger.flush(true)).toBe(logs);
        expect(logger.flush()).toBe(logs);
        expect(logger.flush()).toBe("");
    });

    it("bounds a single oversized message and continues recording afterwards", () => {
        const logger = new ConsoleLogger();
        logger.log("I", "x".repeat(2 * 1024 * 1024) + "message tail");
        logger.log("W", "next message");

        const logs = logger.flush();
        expect(logs.length).toBeLessThanOrEqual(1024 * 1024);
        expect(logs).toContain("message tail");
        expect(logs).toContain("next message");
    });

    it("preserves normal messages and redacts tokens before buffering", () => {
        const logger = new ConsoleLogger();
        logger.log("I", "joined call");
        logger.log("E", "request failed?token=secret-token");

        const logs = logger.flush();
        expect(logs).toContain("I joined call\n");
        expect(logs).toContain("E request failed?token=xxxxx\n");
        expect(logs).not.toContain("secret-token");
    });
});
