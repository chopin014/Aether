/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type CreateServerAudience,
    type CreateServerViewActions,
    type CreateServerViewSnapshot,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { type OpenSpotlightPayload } from "../../dispatcher/payloads/OpenSpotlightPayload";
import { Filter } from "../../components/views/dialogs/spotlight/Filter";
import { _t } from "../../languageHandler";
import { OwnProfileStore } from "../../stores/OwnProfileStore";
import type SpaceStore from "../../stores/spaces/SpaceStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { createServer as defaultCreateServer } from "../../utils/servers/createServer";
import { parseServerInvite } from "../../utils/servers/parseServerInvite";

interface Props {
    client: MatrixClient;
    /** Closes the dialog. */
    onFinished: () => void;
    /** Whether the user may create a community server, which anyone can join. */
    canChooseAudience: boolean;
    /** Creates the server and its channels. */
    createServer?: typeof defaultCreateServer;
    /** Switches to the new server once it exists. */
    spaceStore?: Pick<SpaceStore, "setActiveSpace">;
}

/**
 * Drives the Discord-style "add a server" flow: create a server with a text and a voice channel, or join one with an
 * invite. Joining goes through the usual room view, which then offers the server's channels.
 */
export class CreateServerViewModel
    extends BaseViewModel<CreateServerViewSnapshot, Props>
    implements CreateServerViewActions
{
    private avatar?: File;

    public constructor(props: Props) {
        const ownName = OwnProfileStore.instance.displayName || props.client.getUserIdLocalpart() || "";
        super(props, {
            step: "start",
            canChooseAudience: props.canChooseAudience,
            canExplore: false,
            audience: "friends",
            name: ownName ? _t("desktop|create_server|default_name", { name: ownName }) : "",
            joinAddress: "",
            busy: false,
        });
        this.disposables.track(() => this.revokeAvatarUrl());
        void this.checkExplore();
    }

    /** Public servers can only be listed by homeservers that filter the directory by room type. */
    private async checkExplore(): Promise<void> {
        const { client } = this.props;
        try {
            const canExplore =
                (await client.isVersionSupported("v1.4")) ||
                (await client.doesServerSupportUnstableFeature("org.matrix.msc3827.stable"));
            if (!this.isDisposed) this.snapshot.merge({ canExplore });
        } catch (error) {
            logger.warn("Could not check whether public servers can be listed", error);
        }
    }

    private revokeAvatarUrl(): void {
        const { avatarUrl } = this.snapshot.current;
        if (avatarUrl) URL.revokeObjectURL(avatarUrl);
    }

    public startCreate = (): void => {
        this.snapshot.merge({ step: this.props.canChooseAudience ? "audience" : "customise", error: undefined });
    };

    public startJoin = (): void => {
        this.snapshot.merge({ step: "join", error: undefined });
    };

    public chooseAudience = (audience: CreateServerAudience): void => {
        this.snapshot.merge({ audience, step: "customise", error: undefined });
    };

    public back = (): void => {
        const { step } = this.snapshot.current;
        if (this.snapshot.current.busy) return;
        const previous = step === "customise" && this.props.canChooseAudience ? "audience" : "start";
        this.snapshot.merge({ step: previous, error: undefined });
    };

    public setName = (name: string): void => {
        this.snapshot.merge({ name });
    };

    public setAvatar = (file: File): void => {
        this.revokeAvatarUrl();
        this.avatar = file;
        this.snapshot.merge({ avatarUrl: URL.createObjectURL(file) });
    };

    public create = async (): Promise<void> => {
        const { name, audience, busy } = this.snapshot.current;
        if (busy || !name.trim()) return;
        const { client, createServer = defaultCreateServer } = this.props;

        this.snapshot.merge({ busy: true, error: undefined, progress: _t("desktop|create_server|creating_server") });
        try {
            const server = await createServer(client, { name: name.trim(), audience, avatar: this.avatar }, (step) => {
                if (this.isDisposed) return;
                this.snapshot.merge({
                    progress:
                        step === "server"
                            ? _t("desktop|create_server|creating_server")
                            : _t("desktop|create_server|creating_channels"),
                });
            });
            (this.props.spaceStore ?? SDKContextClass.instance.spaceStore).setActiveSpace(server.spaceId, false);
            defaultDispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: server.textChannelId,
                metricsTrigger: undefined,
            });
            this.props.onFinished();
        } catch (error) {
            logger.error("Failed to create a server", error);
            if (!this.isDisposed) {
                this.snapshot.merge({ busy: false, progress: undefined, error: _t("desktop|create_server|error") });
            }
        }
    };

    public setJoinAddress = (joinAddress: string): void => {
        this.snapshot.merge({ joinAddress, error: undefined });
    };

    public join = (): void => {
        const invite = parseServerInvite(this.snapshot.current.joinAddress);
        if (!invite) {
            this.snapshot.merge({ error: _t("desktop|create_server|invalid_invite") });
            return;
        }
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: invite.roomId,
            room_alias: invite.roomAlias,
            via_servers: invite.viaServers,
            auto_join: true,
            metricsTrigger: undefined,
        });
        this.props.onFinished();
    };

    public explore = (): void => {
        defaultDispatcher.dispatch<OpenSpotlightPayload>({
            action: Action.OpenSpotlight,
            initialFilter: Filter.PublicSpaces,
        });
        this.props.onFinished();
    };
}
