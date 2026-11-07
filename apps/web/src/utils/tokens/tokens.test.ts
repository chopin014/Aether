/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { type AESEncryptedSecretStoragePayload } from "matrix-js-sdk/src/types";

import * as StorageAccess from "../StorageAccess";
import {
    ACCESS_TOKEN_NAME,
    ACCESS_TOKEN_STORAGE_KEY,
    REFRESH_TOKEN_NAME,
    persistTokens,
    tryDecryptToken,
} from "./tokens";

const PICKLE_KEY = "aVerySecretPickleKey";
const ACCESS_TOKEN = "syt_access_token_value";

describe("tokens", () => {
    /** Whatever `persistTokens` wrote, keyed by storage key. */
    let saved: Record<string, unknown>;

    beforeEach(() => {
        saved = {};
        vi.spyOn(StorageAccess, "idbSave").mockImplementation(async (_table, key, data) => {
            saved[key as string] = data;
        });
        localStorage.clear();
    });

    /** Persist an access token with the given pickle key and hand back what landed in storage. */
    async function persistAccessToken(pickleKey: string | undefined): Promise<unknown> {
        await persistTokens(pickleKey, { accessToken: ACCESS_TOKEN });
        return saved[ACCESS_TOKEN_STORAGE_KEY];
    }

    describe("tryDecryptToken", () => {
        it("round-trips a token persisted with the same pickle key", async () => {
            const stored = (await persistAccessToken(PICKLE_KEY)) as AESEncryptedSecretStoragePayload;

            await expect(tryDecryptToken(PICKLE_KEY, stored, ACCESS_TOKEN_NAME)).resolves.toEqual(ACCESS_TOKEN);
        });

        it("throws 'bad MAC' when the pickle key does not match the one used to persist", async () => {
            const stored = (await persistAccessToken(PICKLE_KEY)) as AESEncryptedSecretStoragePayload;

            // This is what a pickle key which has been replaced since the token was written looks
            // like in production, so keep the failure recognisable.
            await expect(tryDecryptToken("aDifferentPickleKey", stored, ACCESS_TOKEN_NAME)).rejects.toThrow(
                "Error decrypting secret access_token: bad MAC",
            );
        });

        it("throws when the token name does not match, since it is an input to the key derivation", async () => {
            const stored = (await persistAccessToken(PICKLE_KEY)) as AESEncryptedSecretStoragePayload;

            await expect(tryDecryptToken(PICKLE_KEY, stored, REFRESH_TOKEN_NAME)).rejects.toThrow(
                "Error decrypting secret refresh_token: bad MAC",
            );
        });
    });

    describe("persistTokens", () => {
        it("stores the token as a plain string when there is no pickle key", async () => {
            // `tryDecryptToken` only accepts encrypted payloads, so callers reading this back have to
            // recognise a plain string themselves rather than handing it over for decryption.
            await expect(persistAccessToken(undefined)).resolves.toEqual(ACCESS_TOKEN);
        });

        it("stores the token as an encrypted object when there is a pickle key", async () => {
            const stored = await persistAccessToken(PICKLE_KEY);
            expect(typeof stored).toBe("object");
            const encryptedPayload = stored as AESEncryptedSecretStoragePayload;
            expect(typeof encryptedPayload.ciphertext).toBe("string");
            expect(typeof encryptedPayload.iv).toBe("string");
            expect(typeof encryptedPayload.mac).toBe("string");
        });

        it("writes nothing once it may no longer, such as when the session changed while it encrypted", async () => {
            let mayWrite = true;
            const writing = persistTokens(PICKLE_KEY, { accessToken: ACCESS_TOKEN, refreshToken: "refresh" }, () => {
                return mayWrite;
            });
            // Encryption is under way; the session is replaced before anything is written.
            mayWrite = false;
            await writing;
            expect(saved).toEqual({});
            expect(localStorage.length).toBe(0);
        });

        it.each(["saved", "failed"])(
            "touches no storage once it may no longer, when a save under way has %s",
            async (outcome) => {
                const saving = Promise.withResolvers<void>();
                vi.mocked(StorageAccess.idbSave).mockReturnValueOnce(saving.promise);
                // A fallback another session left, which must stay.
                localStorage.setItem("mx_access_token_fallback", "theirs");
                let mayWrite = true;
                const writing = persistTokens(undefined, { accessToken: ACCESS_TOKEN }, () => mayWrite);
                await vi.waitFor(() => expect(StorageAccess.idbSave).toHaveBeenCalled());
                // The session is replaced, or logged out, while the save is under way.
                mayWrite = false;
                if (outcome === "saved") saving.resolve();
                else saving.reject(new Error("quota"));
                await writing;
                expect(localStorage.getItem("mx_access_token_fallback")).toBe("theirs");
                expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
            },
        );

        it("asks before writing each token, so a later token is not written once the answer changes", async () => {
            const answers = [true, false];
            await persistTokens(undefined, { accessToken: ACCESS_TOKEN, refreshToken: "refresh" }, () =>
                answers.shift()!,
            );
            expect(Object.keys(saved)).toEqual([ACCESS_TOKEN_STORAGE_KEY]);
        });
    });
});
