/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type JoinRequest,
    type JoinRequestsViewActions,
    type JoinRequestsViewSnapshot,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";
import { RoomStateEvent, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import { mediaFromMxc } from "../../customisations/Media";
import { _t } from "../../languageHandler";
import { canDeclineJoinRequests, pendingJoinRequests } from "../../utils/servers/joinRequests";

interface Props {
    /** The server whose requests to join are shown. */
    space: Room;
}

function toRequest(member: RoomMember): JoinRequest {
    const mxc = member.getMxcAvatarUrl();
    const reason = member.events.member?.getContent().reason;
    return {
        userId: member.userId,
        name: member.rawDisplayName || member.userId,
        avatarUrl: mxc ? (mediaFromMxc(mxc).getThumbnailOfSourceHttp(64, 64, "crop") ?? undefined) : undefined,
        reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined,
    };
}

/**
 * Lists the people asking to join a server, for the members who can let them in. Letting someone in invites them,
 * which their client accepts; turning them down removes the request.
 */
export class JoinRequestsViewModel
    extends BaseViewModel<JoinRequestsViewSnapshot, Props>
    implements JoinRequestsViewActions
{
    public constructor(props: Props) {
        super(props, { ...JoinRequestsViewModel.compute(props.space), expanded: true, busyIds: [] });
        // Requests, the join rule and power levels all arrive as state events.
        this.disposables.trackListener(props.space, RoomStateEvent.Update, this.refresh);
    }

    private static compute(space: Room): Pick<JoinRequestsViewSnapshot, "requests" | "canDecline"> {
        return {
            requests: pendingJoinRequests(space)
                .sort((a, b) => (a.events.member?.getTs() ?? 0) - (b.events.member?.getTs() ?? 0))
                .map(toRequest),
            canDecline: canDeclineJoinRequests(space),
        };
    }

    private refresh = (): void => {
        this.snapshot.merge(JoinRequestsViewModel.compute(this.props.space));
    };

    public toggle = (): void => {
        this.snapshot.merge({ expanded: !this.snapshot.current.expanded });
    };

    private async answer(userId: string, send: () => Promise<unknown>): Promise<void> {
        if (this.snapshot.current.busyIds.includes(userId)) return;
        this.snapshot.merge({ busyIds: [...this.snapshot.current.busyIds, userId], error: undefined });
        try {
            await send();
        } catch (error) {
            logger.warn("Could not answer a request to join", error);
            if (!this.isDisposed) this.snapshot.merge({ error: _t("desktop|join_requests|error") });
        } finally {
            if (!this.isDisposed) {
                this.snapshot.merge({ busyIds: this.snapshot.current.busyIds.filter((id) => id !== userId) });
            }
        }
    }

    public approve = (userId: string): Promise<void> => {
        const { space } = this.props;
        return this.answer(userId, () => space.client.invite(space.roomId, userId));
    };

    public decline = (userId: string): Promise<void> => {
        const { space } = this.props;
        return this.answer(userId, () => space.client.kick(space.roomId, userId));
    };
}
