/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PostmessageTransport, WidgetApiDirection } from "matrix-widget-api";

const require = createRequire(import.meta.url);
const message = {
    api: WidgetApiDirection.ToWidget,
    widgetId: "test-widget",
    requestId: "test-request",
    action: "org.matrix.msc4157.update_delayed_event",
    data: { delay_id: "secret-delay" },
    response: { error: { url: "https://example.org/delayed_events/secret-delay/restart" } },
};

describe("widget transport logs", () => {
    it("logs the action without payloads while delivering the original reply", () => {
        const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const transport = new PostmessageTransport(WidgetApiDirection.ToWidget, "test-widget", window, window);
            transport.reply(message, message.response);
            expect(postMessage).toHaveBeenCalledWith(message, "*");
            expect(log).toHaveBeenCalledWith("[PostmessageTransport] Sending action:", message.action);
            expect(JSON.stringify(log.mock.calls)).not.toContain("secret-delay");
        } finally {
            log.mockRestore();
            postMessage.mockRestore();
        }
    });

    it("also omits payloads in Element Call's bundled widget transport", () => {
        const bundle = readFileSync(
            path.join(path.dirname(require.resolve("@element-hq/element-call-component")), "matrix-C_sMRXGh.js"),
            "utf8",
        );
        const method = bundle.match(/key: "sendInternal",\s*value: (function\(e\) \{[\s\S]*?\n\s*\})/);
        expect(method).not.toBeNull();
        const log = vi.fn();
        const send = runInNewContext(`(${method![1]})`, { console: { log } }) as (
            this: { transportWindow: { postMessage: typeof postMessage }; targetOrigin: string },
            value: typeof message,
        ) => void;
        const postMessage = vi.fn();
        send.call({ transportWindow: { postMessage }, targetOrigin: "*" }, message);
        expect(postMessage).toHaveBeenCalledWith(message, "*");
        expect(log).toHaveBeenCalledWith("[PostmessageTransport] Sending action:", message.action);
        expect(JSON.stringify(log.mock.calls)).not.toContain("secret-delay");
    });
});
