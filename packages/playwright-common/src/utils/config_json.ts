/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type BrowserContext, type Page, type Route } from "@playwright/test";

import { type Config, CONFIG_JSON } from "../index.js";

/**
 * Turn a feature on or off for every client, as an environment variable says, other than for a test that sets it
 * itself, through its lab flags or its own config, such as one that runs both ways.
 * @param features - The config's features.
 * @param feature - The feature.
 * @param mode - "1" for on, "0" for off, anything else to leave it to the test.
 * @param setByTest - Whether the test sets the feature itself.
 */
function forceFeature(
    features: Record<string, boolean>,
    feature: string,
    mode: string | undefined,
    setByTest: boolean,
): void {
    if (setByTest) return;
    if (mode === "1") features[feature] = true;
    else if (mode === "0") features[feature] = false;
}

/** Construct a suitable config.json for the given homeserver
 *
 * @param homeserverBaseUrl - The `baseUrl` of the homeserver that the client should be configured to connect to.
 * @param additionalConfig - Additional config to add to the default config.json.
 * @param labsFlags - Lab flags to enable in the client.
 * @param disablePresence - Whether to disable presence for the given homeserver.
 */
export function buildConfigJson(
    homeserverBaseUrl: string,
    additionalConfig: Partial<Config> = {},
    labsFlags: string[] = [],
    disablePresence: boolean = false,
): Partial<Config> {
    const json = {
        ...CONFIG_JSON,
        ...additionalConfig,
        default_server_config: {
            "m.homeserver": {
                base_url: homeserverBaseUrl,
            },
            ...additionalConfig.default_server_config,
        },
    };
    json["features"] = {
        ...json["features"],
        // Enable the lab features
        ...labsFlags.reduce<NonNullable<(typeof CONFIG_JSON)["features"]>>((obj, flag) => {
            obj[flag] = true;
            return obj;
        }, {}),
    };
    // Simplified Sliding Sync is on by default where the server offers it, and the new timeline is a lab.
    // AETHER_E2E_SLIDING_SYNC=1 or AETHER_E2E_NEW_TIMELINE=1 runs every client with it, and =0 without it, other than in
    // a test that sets it itself, so each way can be checked to match the other. Here, rather than in a fixture, so
    // second clients get it too.
    const setByTest = (feature: string): boolean =>
        labsFlags.includes(feature) || additionalConfig.features?.[feature] !== undefined;
    for (const [feature, mode] of [
        ["feature_simplified_sliding_sync", process.env["AETHER_E2E_SLIDING_SYNC"]],
        ["feature_new_timeline", process.env["AETHER_E2E_NEW_TIMELINE"]],
    ] as const) {
        forceFeature(json["features"], feature, mode, setByTest(feature));
    }
    if (disablePresence) {
        json["enable_presence_by_hs_url"] = {
            [homeserverBaseUrl]: false,
        };
    }
    return json;
}

/**
 * Add a route to the browser context/page which will serve a suitable config.json for the given homeserver.
 *
 * @param context - The browser context or page to route the config.json to.
 * @param homeserverBaseUrl - The `baseUrl` of the homeserver that the client should be configured to connect to.
 * @param additionalConfig - Additional config to add to the default config.json.
 * @param labsFlags - Lab flags to enable in the client.
 * @param disablePresence - Whether to disable presence for the given homeserver.
 */
export async function routeConfigJson(
    context: BrowserContext | Page,
    homeserverBaseUrl: string,
    additionalConfig: Partial<Config> = {},
    labsFlags: string[] = [],
    disablePresence: boolean = false,
): Promise<void> {
    const handler = async (route: Route): Promise<void> => {
        const json = buildConfigJson(homeserverBaseUrl, additionalConfig, labsFlags, disablePresence);
        await route.fulfill({ json });
    };
    // A path, so that Playwright resolves it against the context's `baseURL` and a `BASE_URL` other than the
    // default dev server is served the same config. Deliberately not a `**/config.json` glob: other origins
    // loaded by a test (an Element Call widget, say) have a `config.json` of their own to fetch.
    await context.route("/config.json*", handler);
    // Contexts created without a `baseURL` have nothing to resolve the path against; keep serving the default.
    await context.route("http://localhost:8080/config.json*", handler);
}
