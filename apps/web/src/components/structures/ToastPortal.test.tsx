/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React, { createContext, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "test-utils-rtl";

import { ToastPortal } from "./ToastPortal";

describe("ToastPortal", () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="matrixchat"></div>
            <div id="mx_PersistedElement_container"></div>
            <div id="mx_Dialog_StaticContainer"></div>
            <div id="mx_Dialog_Container"></div>
            <div id="mx_ContextualMenu_Container"></div>
        `;
    });

    afterEach(() => {
        cleanup();
        document.body.innerHTML = "";
    });

    it("should render both toast stacks outside the app and between widgets and dialogs", () => {
        render(
            <ToastPortal>
                <div role="alert">Update ready</div>
                <div role="alert">Background operation failed</div>
            </ToastPortal>,
            { container: document.getElementById("matrixchat")! },
        );

        const host = document.getElementById("mx_Toast_Container")!;
        expect(host.previousElementSibling?.id).toBe("mx_PersistedElement_container");
        expect(host.nextElementSibling?.id).toBe("mx_Dialog_StaticContainer");
        expect(screen.getAllByRole("alert")).toHaveLength(2);
        expect(host.contains(screen.getByText("Update ready"))).toBe(true);
        expect(document.getElementById("matrixchat")!.textContent).toBe("");
    });

    it("should reuse the existing host and remove toast content on unmount", () => {
        const host = document.createElement("div");
        host.id = "mx_Toast_Container";
        document.body.insertBefore(host, document.getElementById("mx_Dialog_StaticContainer"));
        const { unmount } = render(<ToastPortal>Update ready</ToastPortal>);

        expect(document.querySelectorAll("#mx_Toast_Container")).toHaveLength(1);
        expect(host.textContent).toBe("Update ready");
        unmount();
        expect(host.textContent).toBe("");
    });

    it("should create a host when no other overlay hosts exist", () => {
        document.body.innerHTML = "";
        render(<ToastPortal>Update ready</ToastPortal>);
        expect(document.getElementById("mx_Toast_Container")!.textContent).toBe("Update ready");
    });

    it("should preserve context and screen reader visibility across the portal", () => {
        const Context = createContext("missing context");
        function Content(): React.JSX.Element {
            return <div role="alert">{useContext(Context)}</div>;
        }
        const { rerender } = render(
            <Context.Provider value="Update ready">
                <ToastPortal aria-hidden={true}>
                    <Content />
                </ToastPortal>
            </Context.Provider>,
        );
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByRole("alert", { hidden: true }).textContent).toBe("Update ready");

        rerender(
            <ToastPortal aria-hidden={false}>
                <div role="alert">Update ready</div>
            </ToastPortal>,
        );
        expect(screen.getByRole("alert").textContent).toBe("Update ready");
    });
});
