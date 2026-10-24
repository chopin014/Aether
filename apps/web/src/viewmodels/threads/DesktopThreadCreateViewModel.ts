/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopThreadCreateSnapshot,
    type DesktopThreadCreateActions,
} from "@element-hq/web-shared-components";
import {
    EventStatus,
    EventType,
    MsgType,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";

interface Draft {
    starter: string;
    reply: string;
    rootTxn?: string;
    replyTxn?: string;
    rootId?: string;
    replyId?: string;
    sending: boolean;
    error?: boolean;
    listeners: Set<(root?: MatrixEvent) => void>;
}

// Drafts belong to a client session and room, and never survive logout or invent thread metadata.
const drafts = new WeakMap<MatrixClient, Map<string, Draft>>();

interface Props {
    client: MatrixClient;
    room: Room;
    onCreated: (root: MatrixEvent) => void;
    onCancel: () => void;
}

/** Sends through the SDK's normal encrypted message pipeline with stable transaction IDs. */
export class DesktopThreadCreateViewModel
    extends BaseViewModel<DesktopThreadCreateSnapshot, Props>
    implements DesktopThreadCreateActions
{
    private readonly draft: Draft;

    public constructor(props: Props) {
        let roomDrafts = drafts.get(props.client);
        if (!roomDrafts) {
            roomDrafts = new Map();
            drafts.set(props.client, roomDrafts);
        }
        const draft = roomDrafts.get(props.room.roomId) ?? {
            starter: "",
            reply: "",
            sending: false,
            listeners: new Set<(root?: MatrixEvent) => void>(),
        };
        roomDrafts.set(props.room.roomId, draft);
        super(props, {
            starter: draft.starter,
            reply: draft.reply,
            sending: draft.sending,
            locked: !!draft.rootTxn,
            starterSent: !!draft.rootId,
            error: !!draft.error,
        });
        this.draft = draft;
        const onChange = (root?: MatrixEvent): void => {
            this.snapshot.merge({
                starter: draft.starter,
                reply: draft.reply,
                sending: draft.sending,
                locked: !!draft.rootTxn,
                starterSent: !!draft.rootId,
                error: !!draft.error,
            });
            if (root) this.props.onCreated(root);
        };
        draft.listeners.add(onChange);
        this.disposables.track(() => draft.listeners.delete(onChange));
    }

    public setStarter = (starter: string): void => {
        if (this.draft.rootTxn) return;
        this.draft.starter = starter;
        this.publish();
    };

    public setReply = (reply: string): void => {
        if (this.draft.rootTxn) return;
        this.draft.reply = reply;
        this.publish();
    };

    public cancel = (): void => {
        if (!this.draft.sending) this.props.onCancel();
    };

    public submit = async (): Promise<void> => {
        const { room, client } = this.props;
        const draft = this.draft;
        if (draft.sending || !draft.starter.trim() || !draft.reply.trim()) return;
        if (
            room.getMyMembership() !== "join" ||
            !room.currentState.maySendEvent(EventType.RoomMessage, client.getSafeUserId())
        ) {
            draft.error = true;
            this.publish();
            return;
        }
        draft.sending = true;
        draft.rootTxn ??= client.makeTxnId();
        draft.replyTxn ??= client.makeTxnId();
        draft.error = false;
        this.publish();
        try {
            // A successful starter is retained if the reply fails. Resend the SDK local echo on retry.
            if (!draft.rootId) {
                draft.rootId = await this.send(draft.rootTxn, null, { msgtype: MsgType.Text, body: draft.starter });
            }
            if (!draft.replyId) {
                draft.replyId = await this.send(draft.replyTxn, draft.rootId, {
                    msgtype: MsgType.Text,
                    body: draft.reply,
                });
            }
            const root =
                room.findEventById(draft.rootId) ??
                (await client.fetchRoomEvent(room.roomId, draft.rootId).then(client.getEventMapper()));
            if (!root) throw new Error("Starter event is unavailable");
            drafts.get(client)?.delete(room.roomId);
            this.publish(root);
        } catch {
            draft.error = true;
            this.publish();
        } finally {
            draft.sending = false;
            this.publish();
        }
    };

    private publish(root?: MatrixEvent): void {
        for (const listener of this.draft.listeners) listener(root);
    }

    private async send(
        txnId: string,
        threadId: string | null,
        content: { msgtype: MsgType.Text; body: string },
    ): Promise<string> {
        const { client, room } = this.props;
        const pending = room.getPendingEvents().find((event) => event.getTxnId() === txnId);
        if (pending?.status === EventStatus.NOT_SENT) return (await client.resendEvent(pending, room)).event_id;
        return (await client.sendMessage(room.roomId, threadId, content, txnId)).event_id;
    }
}
