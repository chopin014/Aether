/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Text } from "@vector-im/compound-web";
import { CloseIcon, VideoCallSolidIcon, VoiceCallSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import styles from "./IncomingCallView.module.css";

/** A call ringing on this device. */
export interface IncomingCallViewCall {
    /** Identifies the call in the actions. */
    id: string;
    /** The caller's name for a direct call, or the room's name for a group call. */
    name: string;
    /** The avatar for {@link name}. */
    avatarUrl?: string;
    /** Shown in place of a missing avatar. */
    initialLetter: string;
    /** Whether the caller started a voice or a video call. */
    kind: "voice" | "video";
    /** For a call in a group room, the person who started it. Absent for a direct call. */
    startedBy?: string;
}

/** The calls ringing on this device. */
export interface IncomingCallViewSnapshot {
    /** Oldest first. The popup is hidden when there are none. */
    calls: IncomingCallViewCall[];
}

/** Answers to a ringing call. */
export interface IncomingCallViewActions {
    /**
     * Join the call.
     * @param id The call to join.
     * @param withVideo Whether to turn the camera on when joining.
     */
    accept: (id: string, withVideo: boolean) => void;
    /**
     * Stop the call ringing and tell the caller.
     * @param id The call to decline.
     */
    decline: (id: string) => void;
}

/** Model contract for the incoming call popup. */
export type IncomingCallViewModel = ViewModel<IncomingCallViewSnapshot, IncomingCallViewActions>;

function statusText(call: IncomingCallViewCall): string {
    if (call.startedBy) return _t("desktop|incoming_call|started_by", { name: call.startedBy });
    return call.kind === "video" ? _t("desktop|incoming_call|incoming_video") : _t("desktop|incoming_call|incoming");
}

/**
 * A popup for each ringing call, shown in the middle of the window above everything else so a call is never missed.
 * It does not take focus, so whatever the user was typing is not interrupted.
 */
export function IncomingCallView({ vm }: { /** The ringing calls. */ vm: IncomingCallViewModel }): JSX.Element | null {
    const { calls } = useViewModel(vm);
    if (calls.length === 0) return null;
    return (
        <div className={styles.layer}>
            {calls.map((call) => (
                <section
                    key={call.id}
                    className={styles.card}
                    aria-label={_t("desktop|incoming_call|label", { name: call.name })}
                    data-testid="incoming-call"
                >
                    <div className={styles.avatar} aria-hidden>
                        {call.avatarUrl ? (
                            <img src={call.avatarUrl} alt="" className={styles.avatarImage} />
                        ) : (
                            <span className={styles.avatarLetter}>{call.initialLetter}</span>
                        )}
                    </div>
                    <div className={styles.details}>
                        <Text as="p" size="lg" weight="semibold" className={styles.name} title={call.name}>
                            {call.name}
                        </Text>
                        <Text as="p" size="sm" className={styles.status} role="status">
                            {statusText(call)}
                        </Text>
                    </div>
                    <div className={styles.actions}>
                        <button
                            type="button"
                            className={styles.decline}
                            onClick={() => vm.decline(call.id)}
                            aria-label={_t("desktop|incoming_call|decline")}
                            title={_t("desktop|incoming_call|decline")}
                        >
                            <CloseIcon aria-hidden />
                        </button>
                        {call.kind === "video" && (
                            <button
                                type="button"
                                className={styles.accept}
                                onClick={() => vm.accept(call.id, true)}
                                aria-label={_t("desktop|incoming_call|accept_video")}
                                title={_t("desktop|incoming_call|accept_video")}
                            >
                                <VideoCallSolidIcon aria-hidden />
                            </button>
                        )}
                        <button
                            type="button"
                            className={styles.accept}
                            onClick={() => vm.accept(call.id, false)}
                            aria-label={
                                call.kind === "video"
                                    ? _t("desktop|incoming_call|accept_voice")
                                    : _t("desktop|incoming_call|accept")
                            }
                            title={
                                call.kind === "video"
                                    ? _t("desktop|incoming_call|accept_voice")
                                    : _t("desktop|incoming_call|accept")
                            }
                        >
                            <VoiceCallSolidIcon aria-hidden />
                        </button>
                    </div>
                </section>
            ))}
        </div>
    );
}
