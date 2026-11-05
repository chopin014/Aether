/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { createClient, Method, MatrixError } from "matrix-js-sdk/src/matrix";
// oxlint-disable-next-line no-restricted-imports -- the SDK's internal log sanitizer is what is patched and tested here.
import { sanitizeUrlForLogs } from "matrix-js-sdk/src/http-api/logging";

const DELAY_ID = "syd_secret_delay_id";
const RESTART = `https://example.org/_matrix/client/unstable/org.matrix.msc4140/delayed_events/${DELAY_ID}/restart`;

describe("matrix-js-sdk log redaction", () => {
    it("hides delayed event IDs, which act as credentials, in logged URLs", () => {
        expect(sanitizeUrlForLogs(RESTART)).toBe(
            "https://example.org/_matrix/client/unstable/org.matrix.msc4140/delayed_events/xxx/restart",
        );
        expect(sanitizeUrlForLogs("https://example.org/_matrix/client/v1/delayed_events/abc?from=token")).toBe(
            "https://example.org/_matrix/client/v1/delayed_events/xxx?from=xxx",
        );
    });

    it("keeps other paths readable", () => {
        const url = "https://example.org/_matrix/client/v3/rooms/!room:example.org/send/m.room.message/txn";
        expect(sanitizeUrlForLogs(url)).toBe(
            "https://example.org/_matrix/client/v3/rooms/!room:example.org/send/m.room.message/txn",
        );
    });

    it("keeps the ID out of request logs and error messages, but not out of the request", async () => {
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
        Object.assign(logger, { getChild: () => logger });
        const response = new Response(JSON.stringify({ errcode: "M_NOT_FOUND", error: "Unknown delay" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
        // A real response reports the URL it came from, which the error message quotes.
        Object.defineProperty(response, "url", { value: RESTART });
        const fetchFn = vi.fn().mockResolvedValue(response);
        const client = createClient({ baseUrl: "https://example.org", fetchFn, logger: logger as never });

        const error = await client.http.requestOtherUrl(Method.Post, RESTART).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MatrixError);
        expect((error as MatrixError).message).toContain("delayed_events/xxx/restart");
        expect((error as MatrixError).message).not.toContain(DELAY_ID);
        expect(String(fetchFn.mock.calls[0][0])).toContain(DELAY_ID);
        const logged = JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls]);
        expect(logged).toContain("delayed_events/xxx/restart");
        expect(logged).not.toContain(DELAY_ID);
    });
});
