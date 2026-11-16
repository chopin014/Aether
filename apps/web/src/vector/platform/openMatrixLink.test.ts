/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import type MatrixChat from "../../components/structures/MatrixChat";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { getInitialScreenAfterLogin } from "../routing";
import { openMatrixLink, parseMatrixLinkHash } from "./openMatrixLink";

describe("parseMatrixLinkHash", () => {
    it.each([
        [
            "a room alias with servers to join through",
            "#/room/%23aether%3Aexample.org?via=example.org&via=other.net",
            { screen: "room/#aether:example.org", params: { via: ["example.org", "other.net"] } },
        ],
        [
            "a room ID with one server to join through",
            "#/room/!opaque%3Aexample.org?via=example.org",
            { screen: "room/!opaque:example.org", params: { via: "example.org" } },
        ],
        [
            "an event in a room",
            "#/room/!opaque%3Aexample.org/%24abc%2Bd%2Fe",
            { screen: "room/!opaque:example.org/$abc+d/e", params: {} },
        ],
        ["a user", "#/user/%40_bridge%3Dbob%3Aexample.org", { screen: "user/@_bridge=bob:example.org", params: {} }],
    ])("reads %s", (_name, hash, screen) => {
        expect(parseMatrixLinkHash(hash)).toEqual(screen);
    });

    it("keeps only the servers to join through", () => {
        expect(parseMatrixLinkHash("#/user/%40alice%3Aexample.org?action=chat&signurl=https://evil&email=a@b")).toEqual(
            { screen: "user/@alice:example.org", params: {} },
        );
    });

    it.each([
        ["a screen links cannot open", "#/settings"],
        ["the login screen", "#/login"],
        ["a room route without a sigil", "#/room/foo"],
        ["an unencoded route", "#/room/#alias:example.org"],
        ["whitespace", "#/room/%23a%3Ab.org /x"],
        ["something that is not a string", 42],
        ["an over-long route", `#/room/%23a%3Ab.org?via=${"a".repeat(5000)}`],
    ])("rejects %s", (_name, hash) => {
        expect(parseMatrixLinkHash(hash)).toBeUndefined();
    });
});

describe("openMatrixLink", () => {
    const HASH = "#/room/%23aether%3Aexample.org?via=example.org";
    const SCREEN = { screen: "room/#aether:example.org", params: { via: "example.org" } };

    beforeEach(() => {
        sessionStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const chat = (shown: boolean): MatrixChat =>
        ({ openScreenFromLink: vi.fn().mockReturnValue(shown) }) as unknown as MatrixChat;

    it("navigates at once when the user is signed in", () => {
        const matrixChat = chat(true);
        openMatrixLink(HASH, matrixChat);
        expect(matrixChat.openScreenFromLink).toHaveBeenCalledExactlyOnceWith(SCREEN);
        expect(sessionStorage.length).toBe(0);
    });

    it("keeps the link through a sign-in that reloads the app when the user is signed out", () => {
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(null);
        const matrixChat = chat(false);
        openMatrixLink(HASH, matrixChat);
        expect(matrixChat.openScreenFromLink).toHaveBeenCalledExactlyOnceWith(SCREEN);
        expect(getInitialScreenAfterLogin(new URL("https://localhost/") as unknown as Location)).toEqual(SCREEN);
    });

    it("leaves a link for a signed-in user who is still loading to the app", () => {
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue({} as MatrixClient);
        const matrixChat = chat(false);
        openMatrixLink(HASH, matrixChat);
        expect(matrixChat.openScreenFromLink).toHaveBeenCalledExactlyOnceWith(SCREEN);
        expect(sessionStorage.length).toBe(0);
    });

    it("keeps the link for when the app has started", () => {
        openMatrixLink(HASH, undefined);
        expect(getInitialScreenAfterLogin(new URL("https://localhost/") as unknown as Location)).toEqual(SCREEN);
    });

    it("ignores a route that is not a Matrix link", () => {
        const matrixChat = chat(true);
        openMatrixLink("#/settings", matrixChat);
        openMatrixLink({ hash: HASH }, matrixChat);
        expect(matrixChat.openScreenFromLink).not.toHaveBeenCalled();
        expect(sessionStorage.length).toBe(0);
    });
});
