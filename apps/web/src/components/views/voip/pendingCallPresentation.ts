/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import type { AetherCallPresentationBridge } from "./AetherCallPresentationTypes";
import type { ElementCall } from "../../../models/Call";
import SettingsStore from "../../../settings/SettingsStore";

/**
 * The stage's input while Element Call itself is still loading: no engine state yet, so the stage draws the call from
 * what Aether knows (see `DesktopCallStageViewModel`), and leaving is the only action that can mean anything.
 *
 * @param call - The call being loaded.
 * @param roomName - The name to show for it.
 */
export function pendingCallPresentation(call: ElementCall, roomName: string): AetherCallPresentationBridge {
    const noop = (): void => {};
    return {
        state: {
            phase: "joining",
            roomId: call.roomId,
            roomName,
            connected: false,
            reconnecting: false,
            participantCount: call.participants.size,
            localAudioEnabled: !SettingsStore.getValue("audioInputMuted"),
            localVideoEnabled: false,
            sharingScreen: false,
            canShareScreen: false,
            keyRotationSuppressed: false,
            encrypted: true,
            fatalError: null,
            screenShareError: null,
            needsDevicePermissions: false,
            permissionError: null,
            supportsReactions: false,
            ringing: null,
            participants: [],
            screenShares: [],
            lobbyPreviewVideo: null,
            screenShareQuality: { resolutionHeight: 1080, frameRate: 30, maxBitrate: null, includeSystemAudio: false },
            screenSharePolicyLimits: { maxResolutionHeight: null, maxFrameRate: null, maxBitrate: null },
            renderAudioElement: () => null,
        },
        actions: {
            joinCall: noop,
            returnToLobby: noop,
            requestDevicePermissions: noop,
            toggleRaisedHand: noop,
            sendReaction: noop,
            leaveCall: () => {
                call.disconnect().catch((error) => logger.warn("Could not leave a call that was still loading", error));
            },
            reconnect: noop,
            toggleLocalAudio: noop,
            toggleLocalVideo: noop,
            startScreenShare: noop,
            stopScreenShare: noop,
            updateScreenShareQuality: noop,
            dismissScreenShareError: noop,
        },
    };
}
