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
