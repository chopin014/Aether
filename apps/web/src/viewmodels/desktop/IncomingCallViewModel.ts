/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type IncomingCallViewActions,
    type IncomingCallViewCall,
    type IncomingCallViewSnapshot,
} from "@element-hq/web-shared-components";
import { RuleId, TweakName, type MatrixClient } from "matrix-js-sdk/src/matrix";

import { DesktopCallRingtone } from "../../audio/DesktopCallRingtone";
import { mediaFromMxc } from "../../customisations/Media";
import { getInitialLetter } from "../../Avatar";
import defaultDispatcher, { type MatrixDispatcher } from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { type IncomingCall, IncomingCallStore, INCOMING_CALLS_CHANGED } from "../../stores/IncomingCallStore";
import DMRoomMap from "../../utils/DMRoomMap";
import { localNotificationsAreSilenced } from "../../utils/notifications";

interface Props {
    client: MatrixClient;
    /** The ringing calls; the shared store by default. */
    store?: IncomingCallStore;
    /** Where answering a call navigates; the app dispatcher by default. */
    dispatcher?: MatrixDispatcher;
    /** The ring; a new one playing the incoming call sound by default. */
    ringtone?: DesktopCallRingtone;
}

const AVATAR_SIZE = 160;

/** Shows the calls ringing on this device and rings while any of them rang the user directly. */
export class IncomingCallViewModel
    extends BaseViewModel<IncomingCallViewSnapshot, Props>
    implements IncomingCallViewActions
{
    private readonly store: IncomingCallStore;
    private readonly ringtone: DesktopCallRingtone;
    private ringtoneStarted = false;

    public constructor(props: Props) {
        const store = props.store ?? IncomingCallStore.instance;
        super(props, { calls: store.calls.map((call) => toViewCall(props.client, call)) });
        this.store = store;
        this.ringtone = props.ringtone ?? new DesktopCallRingtone("ring");
        this.disposables.trackListener(store, INCOMING_CALLS_CHANGED, this.onCallsChanged);
        this.disposables.track(() => this.ringtone.setRinging(false));
    }

    /** Starts the ring after React commits, so a discarded render cannot leave a second ring playing. */
    public startRingtone = (): (() => void) => {
        if (this.isDisposed) return () => {};
        this.ringtoneStarted = true;
        this.updateRingtone();
        return () => {
            this.ringtoneStarted = false;
            this.ringtone.setRinging(false);
        };
    };

    public accept = (id: string, withVideo: boolean): void => {
        const call = this.store.calls.find((c) => c.key === id);
        if (!call) return;
        this.store.dismiss(id);
        (this.props.dispatcher ?? defaultDispatcher).dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: call.room.roomId,
            view_call: true,
            skipLobby: true,
            voiceOnly: call.voiceOnly || !withVideo,
            metricsTrigger: undefined,
        });
    };

    public decline = (id: string): void => {
        this.store.decline(id);
    };

    private onCallsChanged = (): void => {
        this.snapshot.merge({ calls: this.store.calls.map((call) => toViewCall(this.props.client, call)) });
        this.updateRingtone();
    };

    private updateRingtone(): void {
        if (!this.ringtoneStarted) return;
        this.ringtone.setRinging(this.store.calls.some((call) => call.ring) && callsRingAudibly(this.props.client));
    }
}

/**
 * Whether the user lets calls ring out loud: the incoming call sound in their notification settings, and
 * notifications not silenced on this device.
 */
function callsRingAudibly(client: MatrixClient): boolean {
    if (localNotificationsAreSilenced(client)) return false;
    const rule = client.pushProcessor.getPushRuleById(RuleId.IncomingCall);
    // Servers without the rule have no setting to turn the sound off.
    if (!rule) return true;
    return (
        rule.enabled &&
        rule.actions.some((action) => typeof action !== "string" && action.set_tweak === TweakName.Sound)
    );
}

/** A direct call shows the caller; a call in a group room shows the room and who started the call. */
function toViewCall(client: MatrixClient, call: IncomingCall): IncomingCallViewCall {
    const { room, notificationEvent } = call;
    const senderId = notificationEvent.getSender();
    const sender = senderId ? room.getMember(senderId) : null;
    const senderName = sender?.name ?? senderId ?? room.name;
    const isDirect = DMRoomMap.shared().getUserIdForRoomId(room.roomId) !== undefined;

    const name = isDirect ? senderName : room.name;
    const avatarMxc = isDirect ? sender?.getMxcAvatarUrl() : room.getMxcAvatarUrl();
    const avatarUrl = avatarMxc
        ? (mediaFromMxc(avatarMxc, client).getSquareThumbnailHttp(AVATAR_SIZE) ?? undefined)
        : undefined;
    return {
        id: call.key,
        name,
        avatarUrl,
        initialLetter: getInitialLetter(name) ?? "?",
        kind: call.voiceOnly ? "voice" : "video",
        startedBy: isDirect ? undefined : senderName,
    };
}
