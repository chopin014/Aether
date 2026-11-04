/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IClientWellKnown, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { type Transport } from "matrix-js-sdk/src/matrixrtc";

import { callServiceUrlFor } from "./ElementCallService";
import SdkConfig from "../../../SdkConfig";

const FOCI = "org.matrix.msc4143.rtc_foci";

function makeClient({
    transports,
    wellKnown,
    waitForWellKnown = () => Promise.resolve({} as IClientWellKnown),
}: {
    transports?: Transport[];
    wellKnown?: () => IClientWellKnown | undefined;
    waitForWellKnown?: () => Promise<IClientWellKnown>;
}): MatrixClient {
    return {
        cachedRtcTransports: { get: () => transports },
        getClientWellKnown: wellKnown ?? (() => undefined),
        waitForClientWellKnown: vi.fn(waitForWellKnown),
    } as unknown as MatrixClient;
}

const livekit = (url: string): Transport => ({ type: "livekit", livekit_service_url: url });

describe("callServiceUrlFor", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        SdkConfig.put({ enable_client_well_known_lookups: true });
    });
    afterEach(() => {
        vi.useRealTimers();
        SdkConfig.reset();
    });

    it("names each account's own call service", async () => {
        const first = makeClient({ wellKnown: () => ({ [FOCI]: [livekit("https://first.example")] }) });
        const second = makeClient({
            wellKnown: () => ({ [FOCI]: [{ type: "other" }, livekit("https://second.example")] }),
        });
        await expect(callServiceUrlFor(first)).resolves.toBe("https://first.example");
        await expect(callServiceUrlFor(second)).resolves.toBe("https://second.example");
    });

    it("prefers transports the homeserver lists itself", async () => {
        const client = makeClient({
            transports: [livekit("https://listed.example")],
            wellKnown: () => ({ [FOCI]: [livekit("https://well-known.example")] }),
        });
        await expect(callServiceUrlFor(client)).resolves.toBe("https://listed.example");
        expect(client.waitForClientWellKnown).not.toHaveBeenCalled();
    });

    it("waits for a .well-known that has not arrived yet", async () => {
        const loaded: { wellKnown?: IClientWellKnown } = {};
        const arrived = Promise.withResolvers<IClientWellKnown>();
        const client = makeClient({ wellKnown: () => loaded.wellKnown, waitForWellKnown: () => arrived.promise });
        const url = callServiceUrlFor(client);
        await vi.advanceTimersByTimeAsync(1_000);
        loaded.wellKnown = { [FOCI]: [livekit("https://late.example")] };
        arrived.resolve(loaded.wellKnown);
        await expect(url).resolves.toBe("https://late.example");
    });

    it("stops waiting for a .well-known that never arrives", async () => {
        const client = makeClient({ waitForWellKnown: () => new Promise(() => {}) });
        const url = callServiceUrlFor(client);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(url).resolves.toBeUndefined();
    });

    it("names none when .well-known lookups are off", async () => {
        SdkConfig.put({ enable_client_well_known_lookups: false });
        const client = makeClient({ wellKnown: () => ({ [FOCI]: [livekit("https://ignored.example")] }) });
        await expect(callServiceUrlFor(client)).resolves.toBeUndefined();
        expect(client.waitForClientWellKnown).not.toHaveBeenCalled();
    });
});
