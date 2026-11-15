/*
Copyright 2024 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, ipcMain } from "electron";
import { URL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { type Args, getArgsForProtocolRegistration } from "./args.js";
import { findMatrixLink, getMatrixLinkHash, MATRIX_SCHEME, type MatrixLink } from "./matrix-uri.js";

const LEGACY_PROTOCOL = "element";
const SEARCH_PARAM = "element-desktop-ssoid";
const STORE_FILE_NAME = "sso-sessions.json";
/** Where the app is loaded to open a Matrix link, with the link's route as the fragment. */
const MATRIX_LINK_BASE_URL = "vector://vector/webapp/";

// we getPath userData before electron-main changes it, so this is the default value
const storePath = path.join(app.getPath("userData"), STORE_FILE_NAME);

export default class ProtocolHandler {
    private readonly store: Record<string, string> = {};
    private readonly sessionId: string;

    public constructor(private readonly protocol: string) {
        if (process.platform === "darwin") {
            // Protocol handler for macos
            app.on("open-url", (ev, url) => {
                ev.preventDefault();
                const link = findMatrixLink([url]);
                if (link) this.openMatrixLink(link);
                else this.handleDeeplink(url);
            });
        } else {
            // Protocol handler for win32/Linux
            app.on("second-instance", (ev, commandLine) => {
                const url = commandLine.at(-1);
                if (url && this.checkArgIsUrl(url)) {
                    this.handleDeeplink(url);
                    return;
                }
                // The first argument is the program itself.
                const link = findMatrixLink(commandLine.slice(1));
                if (link) this.openMatrixLink(link);
            });
        }

        this.store = this.readStore();
        this.sessionId = randomUUID();

        ipcMain.handle("getProtocol", this.onGetProtocol);
    }

    private checkArgIsUrl = (arg: string): boolean => {
        return arg.startsWith(`${this.protocol}:/`) || arg.startsWith(`${LEGACY_PROTOCOL}://`);
    };

    private setAsDefaultProtocolClient(parsedArgs: Args): void {
        const args = getArgsForProtocolRegistration(parsedArgs);
        if (app.isPackaged) {
            app.setAsDefaultProtocolClient(this.protocol, process.execPath, args);
            app.setAsDefaultProtocolClient(LEGACY_PROTOCOL, process.execPath, args);
            // Other Matrix apps open matrix: links too, and the person may have chosen one of them: only take the
            // links when nothing handles them. Development builds never register for them.
            if (!app.getApplicationNameForProtocol(`${MATRIX_SCHEME}:`)) {
                app.setAsDefaultProtocolClient(MATRIX_SCHEME, process.execPath, args);
            }
        } else if (process.platform === "win32") {
            // on Mac/Linux this would just cause the electron binary to open
            // special handler for running without being packaged, e.g `electron .` by passing our app path to electron
            app.setAsDefaultProtocolClient(this.protocol, process.execPath, [app.getAppPath(), ...args]);
            app.setAsDefaultProtocolClient(LEGACY_PROTOCOL, process.execPath, [app.getAppPath(), ...args]);
        }
    }

    private readonly onGetProtocol = (): { protocol: string; sessionId: string } => {
        return {
            protocol: this.protocol,
            sessionId: this.sessionId,
        };
    };

    private handleDeeplink(url: string): boolean {
        if (!global.mainWindow) return false;

        const parsed = new URL(url);
        // sanity check: we only register for the one protocol, so we shouldn't
        // be getting anything else unless the user is forcing a URL to open
        // with the Element app.
        if (parsed.protocol !== `${this.protocol}:` && parsed.protocol !== `${LEGACY_PROTOCOL}:`) {
            console.log("Ignoring unexpected protocol: ", parsed.protocol);
            return false;
        }

        const urlToLoad = new URL("vector://vector/webapp/");
        // ignore anything other than the search (used for SSO login redirect)
        // and the hash (for general element deep links)
        // There's no reason to allow anything else, particularly other paths,
        // since this would allow things like the internal jitsi wrapper to
        // be loaded, which would get the app stuck on that page and generally
        // be a bit strange and confusing.
        urlToLoad.search = parsed.search;
        urlToLoad.hash = parsed.hash;

        console.log("Opening URL: ", urlToLoad.href);
        void global.mainWindow.loadURL(urlToLoad.href);
        return true;
    }

    /**
     * Opens a Matrix link in the app. A running app is told where to go, so nothing it is doing, like a call, is
     * interrupted. Otherwise the app is loaded at the link's route, which it also keeps through signing in.
     */
    private openMatrixLink(link: MatrixLink): boolean {
        if (!global.mainWindow) return false;
        const hash = getMatrixLinkHash(link);
        const webContents = global.mainWindow.webContents;
        if (webContents.isLoading()) {
            // The app may not be listening yet, and loading it again at the link costs nothing at this point.
            void global.mainWindow.loadURL(MATRIX_LINK_BASE_URL + hash);
        } else {
            webContents.send("openMatrixLink", hash);
        }
        return true;
    }

    private readStore(): Record<string, string> {
        try {
            const s = fs.readFileSync(storePath, { encoding: "utf8" });
            const o = JSON.parse(s);
            return typeof o === "object" ? o : {};
        } catch (e) {
            console.warn("Unable to read protocol store, starting with empty store: ", e);
            return {};
        }
    }

    private writeStore(): void {
        fs.writeFileSync(storePath, JSON.stringify(this.store));
    }

    /**
     * Initialises the ProtocolHandler
     * Registers the app as the default protocol client for deeplink handling.
     * Handles any deeplink or Matrix link passed in via args on app start.
     * Must be called after mainWindow is set up and any initial navigation is fired.
     * @returns whether a deeplink was present in args and navigated to.
     */
    public initialise(args: Args): boolean {
        this.setAsDefaultProtocolClient(args);

        const url = args.positional.find(this.checkArgIsUrl);
        const link = url ? undefined : findMatrixLink(args.positional);
        let hasDeeplink = false;
        if (url) {
            hasDeeplink = this.handleDeeplink(url);
        } else if (link && global.mainWindow) {
            void global.mainWindow.loadURL(MATRIX_LINK_BASE_URL + getMatrixLinkHash(link));
            hasDeeplink = true;
        }

        for (const key in this.store) {
            // ensure each instance only has one (the latest) session ID to prevent the file growing unbounded
            if (this.store[key] === args.userDataPath) {
                delete this.store[key];
                break;
            }
        }
        this.store[this.sessionId] = args.userDataPath;
        this.writeStore();

        return hasDeeplink;
    }

    public getProfileFromDeeplink(args: string[]): string | undefined {
        // check if we are passed a profile in the SSO callback url
        const deeplinkUrl = args.find(
            (arg) => arg.startsWith(`${this.protocol}:/`) || arg.startsWith(`${LEGACY_PROTOCOL}://`),
        );
        if (deeplinkUrl?.includes(SEARCH_PARAM)) {
            const parsedUrl = new URL(deeplinkUrl);
            if (parsedUrl.protocol === `${this.protocol}:` || parsedUrl.protocol === `${LEGACY_PROTOCOL}:`) {
                const store = this.readStore();
                let sessionId = parsedUrl.searchParams.get(SEARCH_PARAM);
                if (!sessionId) {
                    // In OIDC, we must shuttle the value in the `state` param rather than `element-desktop-ssoid`
                    // We encode it as a suffix like `:element-desktop-ssoid:XXYYZZ`.
                    // The OIDC flow may have used response_mode=fragment or query, so we need to handle both cases.
                    let searchParams = parsedUrl.searchParams;
                    if (parsedUrl.hash.includes("=")) {
                        const [params] = parsedUrl.hash.substring(1).split("?", 2);
                        searchParams = new URLSearchParams(params);
                    }

                    const state = searchParams.get("state");
                    if (state) {
                        sessionId = state.split(`:${SEARCH_PARAM}:`)[1];
                    }
                }

                if (!sessionId) {
                    console.warn("Unable to read session ID in deeplink url:", deeplinkUrl);
                    return undefined;
                }

                console.log("Forwarding to profile:", store[sessionId]);
                return store[sessionId];
            }
        }
    }
}
