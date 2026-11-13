// @vitest-environment happy-dom
/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "test-utils-rtl";

import { useLocalEcho } from "./useLocalEcho";

describe("useLocalEcho", () => {
    it("shows a change while it is sent, and the current value again if sending fails", async () => {
        const { promise, reject } = Promise.withResolvers<void>();
        const onError = vi.fn();
        const { result } = renderHook(() =>
            useLocalEcho<string>(
                () => "shared",
                () => promise,
                onError,
            ),
        );
        expect(result.current[0]).toBe("shared");

        act(() => {
            result.current[1]("world_readable");
        });
        expect(result.current[0]).toBe("world_readable");

        await act(async () => reject(new Error("no")));
        await waitFor(() => expect(result.current[0]).toBe("shared"));
        expect(onError).toHaveBeenCalled();
    });

    it("reads the value again when its source changes", () => {
        const sources = { first: { value: "shared" }, second: { value: "world_readable" } };
        const { result, rerender } = renderHook(
            ({ source }) =>
                useLocalEcho<string>(
                    () => source.value,
                    () => Promise.resolve(),
                    vi.fn(),
                    source,
                ),
            { initialProps: { source: sources.first } },
        );
        expect(result.current[0]).toBe("shared");

        rerender({ source: sources.second });
        expect(result.current[0]).toBe("world_readable");
    });

    it("goes back to the latest value when a change fails after the state has moved on", async () => {
        const { promise, reject } = Promise.withResolvers<void>();
        const onError = vi.fn();
        const sources = { first: { value: "shared" }, second: { value: "invited" } };
        const { result, rerender } = renderHook(
            ({ source }) =>
                useLocalEcho<string>(
                    () => source.value,
                    () => promise,
                    onError,
                    source,
                ),
            { initialProps: { source: sources.first } },
        );
        act(() => {
            result.current[1]("world_readable");
        });
        rerender({ source: sources.second });
        expect(result.current[0]).toBe("invited");

        await act(async () => reject(new Error("no")));
        expect(result.current[0]).toBe("invited");
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("keeps a later change when an earlier one fails", async () => {
        const first = Promise.withResolvers<void>();
        const second = Promise.withResolvers<void>();
        const sends = [first.promise, second.promise];
        const onError = vi.fn();
        const { result } = renderHook(() =>
            useLocalEcho<string>(
                () => "shared",
                () => sends.shift()!,
                onError,
            ),
        );
        act(() => {
            result.current[1]("invited");
        });
        act(() => {
            result.current[1]("world_readable");
        });

        await act(async () => first.reject(new Error("no")));
        expect(result.current[0]).toBe("world_readable");
        expect(onError).toHaveBeenCalledTimes(1);

        await act(async () => second.reject(new Error("no")));
        expect(result.current[0]).toBe("shared");
        expect(onError).toHaveBeenCalledTimes(2);
    });

    it("keeps a change being sent while its source stays the same", () => {
        const source = { value: "shared" };
        const { result, rerender } = renderHook(() =>
            useLocalEcho<string>(
                () => source.value,
                () => new Promise(() => {}),
                vi.fn(),
                source,
            ),
        );

        act(() => {
            result.current[1]("invited");
        });
        rerender();
        expect(result.current[0]).toBe("invited");
    });
});
