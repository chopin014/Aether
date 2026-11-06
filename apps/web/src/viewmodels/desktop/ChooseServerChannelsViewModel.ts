/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type ChooseServerChannelsViewActions,
    type ChooseServerChannelsViewSnapshot,
} from "@element-hq/web-shared-components";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { _t } from "../../languageHandler";
import { joinChannels as defaultJoinChannels, type ServerChannel } from "../../utils/servers/serverChannels";

interface Props {
    client: MatrixClient;
    /** The server that was just joined. */
    space: Room;
    /** Its channels the user has not joined, in the server's order. */
    channels: ServerChannel[];
    /** The channels ticked at first. */
    initialSelection: Set<string>;
    /** Closes the dialog. */
    onFinished: () => void;
    /** Opens the first joined text channel. */
    openFirstChannel: (
        client: MatrixClient,
        spaceId: string,
        channels: ServerChannel[],
        joined: string[],
    ) => Promise<void>;
    /** Joins channels. */
    joinChannels?: typeof defaultJoinChannels;
}

/** Lets someone who just joined a large server choose which of its channels to join. */
export class ChooseServerChannelsViewModel
    extends BaseViewModel<ChooseServerChannelsViewSnapshot, Props>
    implements ChooseServerChannelsViewActions
{
    private selection: Set<string>;

    public constructor(props: Props) {
        super(props, ChooseServerChannelsViewModel.compute(props, props.initialSelection));
        this.selection = new Set(props.initialSelection);
    }

    private static compute(
        { space, channels }: Props,
        selection: Set<string>,
    ): Pick<ChooseServerChannelsViewSnapshot, "serverName" | "channels" | "busy"> {
        return {
            serverName: space.name,
            channels: channels.map((channel) => ({
                id: channel.roomId,
                name: channel.name,
                kind: channel.kind,
                topic: channel.topic,
                memberCount: channel.memberCount,
                selected: selection.has(channel.roomId),
            })),
            busy: false,
        };
    }

    private updateSelection(): void {
        this.snapshot.merge({
            channels: this.snapshot.current.channels.map((channel) => ({
                ...channel,
                selected: this.selection.has(channel.id),
            })),
            error: undefined,
        });
    }

    public toggle = (id: string): void => {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
        this.updateSelection();
    };

    public setAll = (selected: boolean): void => {
        this.selection = new Set(selected ? this.props.channels.map((channel) => channel.roomId) : []);
        this.updateSelection();
    };

    public confirm = async (): Promise<void> => {
        if (this.snapshot.current.busy || this.selection.size === 0) return;
        const { client, space, channels, joinChannels = defaultJoinChannels } = this.props;
        const chosen = channels.filter((channel) => this.selection.has(channel.roomId));

        this.snapshot.merge({ busy: true, error: undefined });
        const { joined, failed } = await joinChannels(client, chosen);
        if (this.isDisposed) return;
        if (joined.length === 0) {
            this.snapshot.merge({ busy: false, error: _t("desktop|choose_channels|error") });
            return;
        }
        if (failed.length > 0) {
            // Keep only what is left to retry, and say which did not work.
            this.selection = new Set(failed.map((channel) => channel.roomId));
            this.snapshot.merge({
                busy: false,
                channels: this.snapshot.current.channels
                    .filter((channel) => !joined.includes(channel.id))
                    .map((channel) => ({ ...channel, selected: this.selection.has(channel.id) })),
                error: _t("desktop|choose_channels|partial_error", {
                    names: failed.map((channel) => channel.name).join(", "),
                }),
            });
            void this.props.openFirstChannel(client, space.roomId, channels, joined);
            return;
        }
        this.props.onFinished();
        await this.props.openFirstChannel(client, space.roomId, channels, joined);
    };

    public skip = (): void => this.props.onFinished();
}
