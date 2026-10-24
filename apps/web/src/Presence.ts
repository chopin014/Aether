/*
Copyright 2024 New Vector Ltd.
Copyright 2019 The Matrix.org Foundation C.I.C.
Copyright 2018 New Vector Ltd
Copyright 2015, 2016 OpenMarket Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type MatrixClient, type SetPresence } from "matrix-js-sdk/src/matrix";

import { MatrixClientPeg } from "./MatrixClientPeg";
import dis from "./dispatcher/dispatcher";
import { PresenceViewModel } from "./viewmodels/presence/PresenceViewModel";

class Presence {
    private client?: MatrixClient;
    private model?: PresenceViewModel;

    /** Share one controller between activity tracking and the authenticated account menu. */
    public forClient(client: MatrixClient): PresenceViewModel {
        if (this.client !== client || !this.model || this.model.isDisposed) {
            this.stop();
            this.client = client;
            this.model = new PresenceViewModel({ client, dispatcher: dis });
        }
        return this.model;
    }

    /** Begin activity tracking after the SDK has started. */
    public async start(): Promise<void> {
        this.forClient(MatrixClientPeg.safeGet()).start();
    }

    /** Dispose account listeners and timers before logout or a client change. */
    public stop(): void {
        this.model?.dispose();
        this.model = undefined;
        this.client = undefined;
    }

    /** Return the last presence actually received from the server. */
    public getState(): SetPresence | null {
        return (this.model?.getSnapshot().current as SetPresence | undefined) ?? null;
    }
}

export default new Presence();
