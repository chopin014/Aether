/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import type { ReactNode } from "react";
import MediaDeviceHandler from "../../../MediaDeviceHandler";
import ActiveWidgetStore from "../../../stores/ActiveWidgetStore";
import { CallStore } from "../../../stores/CallStore";
import { type ElementCall } from "../../../models/Call";
import {
    type DeviceMuteState,
    type ElementCallHostBridge,
    type ScreenShareState,
    type VoiceState,
    type ConnectionStats,
} from "@element-hq/element-call-component/api";
import { logger } from "matrix-js-sdk/src/logger";

import type { AetherCallPresentationBridge } from "./AetherCallPresentationTypes";
import type { SoundboardTransport } from "../../../audio/soundboard/SoundboardTransport";

export interface ElementWebHostBridgeOptions {
    /** The id of the (virtual) widget that is this call's identity in the widget stores. */
    widgetId: string;
    /** The room the widget belongs to, as `ActiveWidgetStore` keys it. */
    widgetRoomId: string | null;
    /** Optional Aether presentation renderer replacing Element Call's built-in UI while preserving engine & audio. */
    renderPresentation?: (bridge: AetherCallPresentationBridge) => ReactNode;
}

/**
 * What the Element Call React component tells Element Web: the `ElementCallHostBridge` callbacks, each
 * forwarding to the `ElementCall` model or the widget stores, replacing what `WidgetMessaging` plus the
 * model's widget action handlers do for the iframe embedding.
 *
 * Stateless, so its identity does not matter: the component forwards to whichever bridge it was most
 * recently given. What Element Web asks of the component goes the other way, through the component's
 * `ElementCallHandle`, which the model holds (`setComponentHandle`).
 *
 * The callbacks are bound (arrow properties): Element Call may pull one off the bridge and call it on its
 * own (it does so for `close`, whose presence it also reads), so none of them may depend on `this` being
 * the bridge at the call.
 */
export class ElementWebHostBridge implements ElementCallHostBridge {
    public readonly supportsReactions = true;

    /** Bind real-time sound playback without using rate-limited Matrix timeline events. */
    public readonly notifySoundboardTransport = async (transport: unknown): Promise<void> => {
        this.call.handleSoundboardTransport(transport as SoundboardTransport | null);
    };

    /**
     * Element Web chose the intent on the user's behalf (which button they pressed), so a call that skips
     * the lobby may start them unmuted on its strength, as it does when Element Web hosts Element Call as a
     * widget. Standalone Element Call, whose intent comes from a URL, starts the user muted instead.
     */
    public get allowJoinUnmutedViaIntent(): boolean {
        return !MediaDeviceHandler.startWithAudioMuted;
    }

    public readonly renderPresentation?: (bridge: unknown) => ReactNode;

    public constructor(
        private readonly call: ElementCall,
        private readonly opts: ElementWebHostBridgeOptions,
    ) {
        if (opts.renderPresentation) {
            const render = opts.renderPresentation;
            this.renderPresentation = (bridge: unknown): ReactNode => render(bridge as AetherCallPresentationBridge);
        }
    }

    public readonly setAlwaysOnScreen = async (alwaysOnScreen: boolean): Promise<void> => {
        // Only one call can be on screen. Before this one becomes sticky, hang up every other connected
        // call, as `CallView`'s stickyPromise does for the iframe embedding (through WidgetMessaging's
        // UpdateAlwaysOnScreen handling).
        if (alwaysOnScreen) {
            const others = [...CallStore.instance.connectedCalls].filter((call) => call !== this.call);
            try {
                await Promise.all(others.map((call) => call.disconnect()));
            } catch (e) {
                logger.warn("Could not disconnect other calls before making this one persistent", e);
            }
        }
        ActiveWidgetStore.instance.setWidgetPersistence(this.opts.widgetId, this.opts.widgetRoomId, alwaysOnScreen);
    };

    public readonly contentLoaded = async (): Promise<void> => {
        this.call.markReady();
    };

    public readonly notifyJoined = async (): Promise<void> => {
        this.call.handleJoined();
    };

    public readonly notifyHungUp = async (): Promise<void> => {
        this.call.handleHangup();
    };

    public readonly notifyDeviceMute = async (state: DeviceMuteState): Promise<void> => {
        this.call.handleDeviceMute(state);
    };

    /** Forward real speech activity, already deduplicated across a user's devices. */
    public readonly notifySpeakingUsers = async (userIds: string[]): Promise<void> => {
        this.call.handleSpeakingUsers(userIds);
    };

    /** Forward screen sharing, so the sidebar can offer it and the floating call only shows a share. */
    public readonly notifyScreenShare = async (state: ScreenShareState): Promise<void> => {
        this.call.handleScreenShare(state);
    };

    /** Forward who is muted or deafened, so the channel list can show it beside each person. */
    public readonly notifyVoiceStates = async (states: VoiceState[]): Promise<void> => {
        this.call.handleVoiceStates(states);
    };

    /** Forward media transport measurements, which the model validates before showing them. */
    public readonly notifyConnectionStats = async (stats: ConnectionStats): Promise<void> => {
        this.call.handleConnectionStats(stats);
    };

    public readonly close = async (): Promise<void> => {
        this.call.handleClose();
    };
}
