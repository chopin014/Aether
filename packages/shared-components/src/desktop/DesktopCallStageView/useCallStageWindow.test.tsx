/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@test-utils";

import { useCallStageWindow } from "./useCallStageWindow";

function WindowHarness(): React.JSX.Element {
    const { popoutWindow, openPopout, canPopout, popoutFailed } = useCallStageWindow();
    const content = <button type="button">Call control</button>;
    return (
        <>
            {canPopout && (
                <button type="button" onClick={() => void openPopout()}>
                    Float call
                </button>
            )}
            {popoutFailed && <span role="alert">Could not open</span>}
            {popoutWindow ? createPortal(content, popoutWindow.document.body) : content}
        </>
    );
}

describe("useCallStageWindow", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("moves interactive content to a themed window and returns it when that window closes", async () => {
        document.body.style.setProperty("--test-call-theme", "#123456");
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const target = iframe.contentWindow!;
        const close = vi.spyOn(target, "close").mockImplementation(() => {});
        const requestWindow = vi.fn().mockResolvedValue(target);
        vi.stubGlobal("documentPictureInPicture", { requestWindow });
        const { unmount } = render(<WindowHarness />);
        fireEvent.click(screen.getByRole("button", { name: "Float call" }));
        await waitFor(() => expect(target.document.body.textContent).toContain("Call control"));
        expect(requestWindow).toHaveBeenCalledWith({ width: 960, height: 640 });
        expect(target.document.head.querySelector("base")?.href).toBe(document.baseURI);
        expect(target.document.documentElement.style.getPropertyValue("--test-call-theme")).toBe("#123456");
        expect(screen.queryByRole("button", { name: "Call control" })).not.toBeInTheDocument();
        await act(() => {
            target.dispatchEvent(new Event("pagehide"));
        });
        expect(screen.getByRole("button", { name: "Call control" })).toBeInTheDocument();
        unmount();
        expect(close).not.toHaveBeenCalled();
        iframe.remove();
        document.body.style.removeProperty("--test-call-theme");
    });

    it("reports a rejected request and allows another attempt", async () => {
        const requestWindow = vi.fn().mockRejectedValue(new Error("Denied"));
        vi.stubGlobal("documentPictureInPicture", { requestWindow });
        render(<WindowHarness />);
        fireEvent.click(screen.getByRole("button", { name: "Float call" }));
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
        expect(screen.getByRole("button", { name: "Call control" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Float call" }));
        await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(2));
    });

    it("closes a window that arrives after the call has unmounted", async () => {
        let resolve!: (target: Window) => void;
        const requestWindow = vi.fn(
            () =>
                new Promise<Window>((done) => {
                    resolve = done;
                }),
        );
        const target = { close: vi.fn() } as unknown as Window;
        vi.stubGlobal("documentPictureInPicture", { requestWindow });
        const { unmount } = render(<WindowHarness />);
        fireEvent.click(screen.getByRole("button", { name: "Float call" }));
        unmount();
        await act(async () => resolve(target));
        expect(target.close).toHaveBeenCalledOnce();
    });

    it("does not offer a floating window when the browser cannot open one", () => {
        vi.stubGlobal("documentPictureInPicture", undefined);
        render(<WindowHarness />);
        expect(screen.queryByRole("button", { name: "Float call" })).not.toBeInTheDocument();
    });
});
