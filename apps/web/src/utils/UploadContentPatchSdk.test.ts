/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Tests for the patched SDK's upload timeout, which gives an upload whose body has all been handed to the network time
// to reach the server before giving up.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientPrefix, MatrixError, MatrixHttpApi, TypedEventEmitter } from "matrix-js-sdk/src/matrix";

/** A stand-in for the browser's XMLHttpRequest that the test drives by hand. */
class FakeXhr {
    public static readonly DONE = 4;
    public static last?: FakeXhr;

    public readyState = 0;
    public status = 0;
    public responseText = "";
    public responseURL = "";
    public onreadystatechange?: () => void;
    public readonly upload: { onprogress?: (ev: Partial<ProgressEvent>) => void } = {};
    public aborted = false;
    private responseHeaders = "";

    public constructor() {
        FakeXhr.last = this;
    }

    public open(_method: string, url: string): void {
        this.responseURL = url;
    }
    public setRequestHeader(): void {}
    public send(): void {}
    public getResponseHeader(): string | null {
        return null;
    }
    public getAllResponseHeaders(): string {
        return this.responseHeaders;
    }

    public abort(): void {
        this.aborted = true;
        this.finish(0, "");
    }

    /** Reports this much of the body as sent. */
    public progress(loaded: number, total: number): void {
        this.upload.onprogress?.({ lengthComputable: true, loaded, total });
    }

    /** Answers the request. */
    public finish(status: number, body: string): void {
        this.status = status;
        this.responseText = body;
        this.responseHeaders = status ? "content-type: application/json\r\n" : "";
        this.readyState = FakeXhr.DONE;
        this.onreadystatechange?.();
    }
}

function makeApi(): MatrixHttpApi<{ baseUrl: string; prefix: ClientPrefix; onlyData: true }> {
    return new MatrixHttpApi(new TypedEventEmitter(), {
        baseUrl: "https://matrix.example.org",
        prefix: ClientPrefix.V3,
        onlyData: true,
        accessToken: "token",
        useAuthorizationHeader: true,
    });
}

describe("patched uploadContent", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal("XMLHttpRequest", FakeXhr);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        FakeXhr.last = undefined;
    });

    it("waits for the server once the whole body has been sent", async () => {
        const progress = vi.fn();
        const upload = makeApi().uploadContent(new File(["x".repeat(100)], "early_xmas.zip"), {
            progressHandler: progress,
        });
        const xhr = FakeXhr.last!;

        // The browser buffers the whole file at once, then reports nothing more until the server answers.
        xhr.progress(10_000_000, 10_000_000);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(xhr.aborted).toBe(false);

        xhr.finish(200, JSON.stringify({ content_uri: "mxc://matrix.example.org/abc" }));
        await expect(upload).resolves.toEqual({ content_uri: "mxc://matrix.example.org/abc" });
        expect(progress).toHaveBeenLastCalledWith({ loaded: 10_000_000, total: 10_000_000 });
    });

    it("gives up on a server that never answers once the body has had time to arrive", async () => {
        const upload = makeApi().uploadContent(new File(["x".repeat(100)], "early_xmas.zip"));
        const rejected = upload.catch((e: unknown) => e);
        const xhr = FakeXhr.last!;

        // 30 s, plus 10 MB at 32 KB/s.
        xhr.progress(10_000_000, 10_000_000);
        await vi.advanceTimersByTimeAsync(342_000);
        expect(xhr.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(xhr.aborted).toBe(true);
        expect(await rejected).toBeInstanceOf(Error);
    });

    it("hands back the server's answer when the file is too large", async () => {
        const upload = makeApi().uploadContent(new File(["x".repeat(100)], "early_xmas.zip"));
        const xhr = FakeXhr.last!;

        xhr.progress(10_000_000, 10_000_000);
        await vi.advanceTimersByTimeAsync(35_000);
        xhr.finish(413, JSON.stringify({ errcode: "M_TOO_LARGE", error: "Upload request body is too large" }));

        const error = await upload.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MatrixError);
        expect(error).toMatchObject({ httpStatus: 413, errcode: "M_TOO_LARGE" });
    });

    it("still gives up when sending stalls part way", async () => {
        const upload = makeApi().uploadContent(new File(["x".repeat(100)], "early_xmas.zip"));
        const rejected = upload.catch((e: unknown) => e);
        const xhr = FakeXhr.last!;

        xhr.progress(40, 100);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(xhr.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(xhr.aborted).toBe(true);
        expect(await rejected).toBeInstanceOf(Error);
    });
});
