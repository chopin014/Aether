/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type VoiceUserMenuRole,
    type VoiceUserMenuServer,
    type VoiceUserMenuViewModel as VoiceUserMenuViewModelInterface,
    type VoiceUserMenuViewSnapshot,
} from "@element-hq/web-shared-components";
import {
    ClientEvent,
    EventType,
    RoomStateEvent,
    User,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";
import { copyPlainTextToClipboard } from "@element-hq/element-web-shared-utils";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewUserPayload } from "../../dispatcher/payloads/ViewUserPayload";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { type ComposerInsertPayload } from "../../dispatcher/payloads/ComposerInsertPayload";
import { type OpenToTabPayload } from "../../dispatcher/payloads/OpenToTabPayload";
import { TimelineRenderingType } from "../../contexts/RoomContext";
import { UserTab } from "../../components/views/dialogs/UserTab";
import { DirectoryMember, startDmOnFirstMessage } from "../../utils/direct-messages";
import { findDMRoom } from "../../utils/dm/findDMRoom";
import { verifyUser } from "../../verification";
import RightPanelStore from "../../stores/right-panel/RightPanelStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import SettingsStore from "../../settings/SettingsStore";
import Modal from "../../Modal";
import ErrorDialog from "../../components/views/dialogs/ErrorDialog";
import QuestionDialog from "../../components/views/dialogs/QuestionDialog";
import { warnSelfDemote } from "../../components/views/right_panel/UserInfo";
import {
    confirmAndIgnoreUser,
    unignoreUser,
} from "../../components/viewmodels/right_panel/user_info/UserInfoIgnoreButtonViewModel";
import { textualPowerLevel } from "../../Roles";
import { _t } from "../../languageHandler";
import { VoiceUserPreferences, VoiceUserPreferencesEvent } from "../../audio/desktop/VoiceUserPreferences";

/** The person a voice user menu is about, and where they were found. */
export interface VoiceUserMenuViewModelProps {
    client: MatrixClient;
    userId: string;
    /** The voice channel or conversation they were found in: it gives their name, and the roles that can change. */
    room?: Room;
    /** Where the user's servers come from; the app's Space store unless a test supplies one. */
    spaceStore?: { readonly spacePanelSpaces: Room[] };
}

/** The standard roles, highest first, as Element's power level editor offers them. */
const ROLE_LEVELS = [100, 50] as const;

/**
 * A person's menu in a voice channel or call. Every entry is an existing Matrix or Aether flow: their profile, a
 * direct conversation, per-person playback kept by {@link VoiceUserPreferences}, verification, ignoring, inviting
 * them to a Space and their power level in the channel.
 */
export class VoiceUserMenuViewModel
    extends BaseViewModel<VoiceUserMenuViewSnapshot, VoiceUserMenuViewModelProps>
    implements VoiceUserMenuViewModelInterface
{
    public constructor(props: VoiceUserMenuViewModelProps) {
        super(props, VoiceUserMenuViewModel.build(props));
        this.disposables.trackListener(VoiceUserPreferences.instance, VoiceUserPreferencesEvent.Changed, this.refresh);
        for (const setting of ["audioInputMuted", "desktopDeafened"] as const) {
            const ref = SettingsStore.watchSetting(setting, null, this.refresh);
            this.disposables.track(() => SettingsStore.unwatchSetting(ref));
        }
        this.disposables.trackListener(props.client, ClientEvent.AccountData, this.refresh);
        if (props.room) this.disposables.trackListener(props.room, RoomStateEvent.Events, this.onRoomState);
        void this.loadVerification();
    }

    private static build(props: VoiceUserMenuViewModelProps): VoiceUserMenuViewSnapshot {
        const { client, userId, room } = props;
        const isSelf = userId === client.getUserId();
        const preference = VoiceUserPreferences.instance.get(userId);
        return {
            userId,
            displayName: VoiceUserMenuViewModel.displayName(props),
            isSelf,
            canMention: true,
            canMessage: !isSelf,
            canCall: !isSelf && !!findDMRoom(client, [new DirectoryMember({ user_id: userId })]),
            volumePercent: Math.round(preference.volume * 100),
            muted: preference.muted,
            soundboardMuted: preference.soundboardMuted,
            videoDisabled: preference.videoDisabled,
            microphoneMuted: SettingsStore.getValue("audioInputMuted"),
            deafened: SettingsStore.getValue("desktopDeafened"),
            // Shown once the person's cross-signing status is known; see loadVerification.
            canVerify: false,
            isIgnored: client.isUserIgnored(userId),
            inviteServers: isSelf
                ? []
                : VoiceUserMenuViewModel.inviteServers(
                      client,
                      userId,
                      props.spaceStore ?? SDKContextClass.instance.spaceStore,
                  ),
            roles: room ? VoiceUserMenuViewModel.roles(client, room, userId) : [],
        };
    }

    private static displayName({ client, userId, room }: VoiceUserMenuViewModelProps): string {
        return room?.getMember(userId)?.name || client.getUser(userId)?.displayName || userId;
    }

    /** Spaces the user may invite to, that the person has not joined or been invited to yet. */
    private static inviteServers(
        client: MatrixClient,
        userId: string,
        spaceStore: NonNullable<VoiceUserMenuViewModelProps["spaceStore"]>,
    ): VoiceUserMenuServer[] {
        const me = client.getSafeUserId();
        return spaceStore.spacePanelSpaces
            .filter((space) => {
                const membership = space.getMember(userId)?.membership;
                return (
                    space.canInvite(me) &&
                    membership !== KnownMembership.Join &&
                    membership !== KnownMembership.Invite &&
                    membership !== KnownMembership.Ban
                );
            })
            .map((space) => ({ id: space.roomId, name: space.name }));
    }

    /**
     * The roles the user may give the person in this room. As in Element, a level can only be changed by someone
     * above it, and never raised past the user's own level.
     */
    private static roles(client: MatrixClient, room: Room, userId: string): VoiceUserMenuRole[] {
        const me = client.getSafeUserId();
        const target = room.getMember(userId);
        const myLevel = room.getMember(me)?.powerLevel;
        if (!target || myLevel === undefined || !Number.isFinite(target.powerLevel)) return [];
        if (!room.currentState.maySendStateEvent(EventType.RoomPowerLevels, me)) return [];
        if (userId !== me && target.powerLevel >= myLevel) return [];
        const content = room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
        const usersDefault: number = typeof content.users_default === "number" ? content.users_default : 0;
        return [...new Set([...ROLE_LEVELS, usersDefault])]
            .filter((level) => level <= myLevel)
            .sort((a, b) => b - a)
            .map((level) => ({
                level,
                label: textualPowerLevel(level, usersDefault),
                selected: target.powerLevel === level,
            }));
    }

    private readonly refresh = (): void => {
        if (this.isDisposed) return;
        this.snapshot.merge({
            ...VoiceUserMenuViewModel.build(this.props),
            canVerify: this.snapshot.current.canVerify,
        });
    };

    private readonly onRoomState = (...args: unknown[]): void => {
        // trackListener types its listeners loosely; RoomStateEvent.Events passes the event first.
        const type = (args[0] as MatrixEvent).getType();
        if (type === EventType.RoomPowerLevels || type === EventType.RoomMember) this.refresh();
    };

    /** Verification is offered while the person's identity is not verified yet. */
    private async loadVerification(): Promise<void> {
        const { client, userId } = this.props;
        const crypto = client.getCrypto();
        if (!crypto || userId === client.getUserId()) return;
        try {
            const status = await crypto.getUserVerificationStatus(userId);
            if (!this.isDisposed) this.snapshot.merge({ canVerify: !status.isCrossSigningVerified() });
        } catch (error) {
            logger.warn("Could not read the verification status", error);
        }
    }

    private member(): User | NonNullable<ReturnType<Room["getMember"]>> {
        const { client, userId, room } = this.props;
        return room?.getMember(userId) ?? client.getUser(userId) ?? User.createUser(userId, client);
    }

    public viewProfile = (): void => {
        defaultDispatcher.dispatch<ViewUserPayload>({ action: Action.ViewUser, member: this.member() });
    };

    public mention = (): void => {
        defaultDispatcher.dispatch<ComposerInsertPayload>({
            action: Action.ComposerInsert,
            userId: this.props.userId,
            timelineRenderingType: TimelineRenderingType.Room,
        });
    };

    public message = async (): Promise<void> => {
        const member = this.member();
        try {
            await startDmOnFirstMessage(this.props.client, [
                new DirectoryMember({
                    user_id: this.props.userId,
                    display_name: "name" in member ? member.name : (member.displayName ?? undefined),
                    avatar_url: "getMxcAvatarUrl" in member ? member.getMxcAvatarUrl() : member.avatarUrl,
                }),
            ]);
        } catch (error) {
            logger.warn("Could not open the direct conversation", error);
        }
    };

    /** Opens the call in the existing direct conversation, where the usual lobby asks before joining. */
    public startCall = (): void => {
        const room = findDMRoom(this.props.client, [new DirectoryMember({ user_id: this.props.userId })]);
        if (!room) return;
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: room.roomId,
            view_call: true,
            voiceOnly: true,
            metricsTrigger: undefined,
        });
    };

    public setVolume = (percent: number): void => {
        void VoiceUserPreferences.instance.setVolume(this.props.userId, percent / 100);
    };

    public toggleMuted = (): void => {
        void VoiceUserPreferences.instance.toggleMuted(this.props.userId);
    };

    public toggleSoundboardMuted = (): void => {
        void VoiceUserPreferences.instance.update(this.props.userId, {
            soundboardMuted: !this.snapshot.current.soundboardMuted,
        });
    };

    public toggleVideoDisabled = (): void => {
        void VoiceUserPreferences.instance.update(this.props.userId, {
            videoDisabled: !this.snapshot.current.videoDisabled,
        });
    };

    public toggleMicrophoneMuted = (): void => {
        defaultDispatcher.dispatch({ action: Action.ToggleDesktopMicrophone });
    };

    public toggleDeafened = (): void => {
        defaultDispatcher.dispatch({ action: Action.ToggleDesktopDeafen });
    };

    public editProfile = (): void => {
        defaultDispatcher.dispatch<OpenToTabPayload>({
            action: Action.ViewUserSettings,
            initialTabId: UserTab.Profile,
        });
    };

    public verify = (): void => {
        const { client, userId } = this.props;
        verifyUser(RightPanelStore.instance, client, client.getUser(userId) ?? User.createUser(userId, client));
    };

    public inviteToServer = async (serverId: string): Promise<void> => {
        const { client, userId } = this.props;
        try {
            await client.invite(serverId, userId);
        } catch (error) {
            logger.warn("Could not invite to the Space", error);
            Modal.createDialog(ErrorDialog, {
                title: _t("desktop|voice_user_menu|invite_failed_title"),
                description: error instanceof Error ? error.message : String(error),
            });
        }
    };

    public copyUserId = (): void => {
        void copyPlainTextToClipboard(this.props.userId);
    };

    public toggleIgnore = (): void => {
        const { client, userId } = this.props;
        if (client.isUserIgnored(userId)) void unignoreUser(client, userId);
        else void confirmAndIgnoreUser(client, this.member());
    };

    /** Changes the person's power level in the room, with Element's warnings for changes that cannot be undone. */
    public setRole = async (level: number): Promise<void> => {
        const { client, room, userId } = this.props;
        if (!room) return;
        const me = client.getSafeUserId();
        const myLevel = room.getMember(me)?.powerLevel;
        const current = room.getMember(userId)?.powerLevel;
        if (myLevel === undefined || current === level) return;
        if (userId !== me && level >= myLevel) {
            const { finished } = Modal.createDialog(QuestionDialog, {
                title: _t("common|warning"),
                description: `${_t("user_info|promote_warning")} ${_t("common|are_you_sure")}`,
                button: _t("action|continue"),
            });
            const [confirmed] = await finished;
            if (!confirmed) return;
        } else if (userId === me && level < myLevel && !(await warnSelfDemote(room.isSpaceRoom()))) {
            return;
        }
        try {
            await client.setPowerLevel(room.roomId, userId, level);
        } catch (error) {
            logger.error("Failed to change power level", error);
            Modal.createDialog(ErrorDialog, {
                title: _t("common|error"),
                description: _t("error|update_power_level"),
            });
        }
    };
}
