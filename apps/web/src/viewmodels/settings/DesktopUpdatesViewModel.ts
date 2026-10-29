/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopUpdatesViewActions,
    type DesktopUpdatesViewSnapshot,
} from "@element-hq/web-shared-components";

import PlatformPeg from "../../PlatformPeg";
import { restartDesktopUpdate } from "../../toasts/restartDesktopUpdate";

/** Keeps the update page in sync with the native updater while it is open. */
export class DesktopUpdatesViewModel
    extends BaseViewModel<DesktopUpdatesViewSnapshot, undefined>
    implements DesktopUpdatesViewActions
{
    public constructor() {
        super(undefined, {
            state: {
                status: "unsupported",
                currentVersion: "",
                reason: "platform",
            },
            loading: true,
        });

        const platform = PlatformPeg.get();
        if (!platform) {
            this.snapshot.merge({ loading: false });
            return;
        }

        let stateEventsReceived = 0;
        this.disposables.track(
            platform.onDesktopUpdateStateChanged((state) => {
                if (this.isDisposed) return;
                stateEventsReceived++;
                this.snapshot.merge({ state, loading: false });
            }),
        );

        void platform
            .getDesktopUpdateState()
            .then((state) => {
                if (this.isDisposed || stateEventsReceived > 0) return;
                this.snapshot.merge({ state, loading: false });
            })
            .catch(() => {
                if (!this.isDisposed && stateEventsReceived === 0) {
                    this.snapshot.merge({
                        state: { status: "error", currentVersion: this.snapshot.current.state.currentVersion },
                        loading: false,
                    });
                }
            });
    }

    /** Starts a new manual check. */
    public checkForUpdates = (): void => {
        const { state, loading } = this.snapshot.current;
        if (loading || (state.status !== "idle" && state.status !== "error")) return;
        PlatformPeg.get()?.startUpdateCheck();
    };

    /** Applies the downloaded update after explicit user intent. */
    public restartToUpdate = (): void => {
        if (this.isDisposed || this.snapshot.current.loading || this.snapshot.current.state.status !== "ready") return;
        restartDesktopUpdate();
    };
}
