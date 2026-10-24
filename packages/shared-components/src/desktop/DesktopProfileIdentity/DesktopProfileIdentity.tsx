/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";
import classNames from "classnames";
import { Avatar, Text, useIdColorHash } from "@vector-im/compound-web";

import { useI18n } from "../../core/i18n/i18nContext";
import { type UserStatus } from "../../core/userStatus";
import styles from "./DesktopProfileIdentity.module.css";

/** Presence the server has actually reported; unknown presence is represented by omitting it. */
export type DesktopProfilePresence = "online" | "unavailable" | "offline";

/** A Matrix power-level role shown where Discord shows server roles. */
export interface DesktopProfileRole {
    key: string;
    label: string;
}

/** Who the profile is about, shared by the popout card and the full profile. */
export interface DesktopProfileIdentitySnapshot {
    userId: string;
    displayName: string;
    avatarUrl?: string;
    presence?: DesktopProfilePresence;
    roles: DesktopProfileRole[];
    /** The user's extended-profile status, when the server provides one. */
    status?: UserStatus;
}

interface PresenceBadgeProps {
    presence: DesktopProfilePresence;
}

/** Presence mark with a canvas-coloured ring so it reads as cut out of the avatar. */
function PresenceBadge({ presence }: PresenceBadgeProps): JSX.Element {
    const { translate: _t } = useI18n();
    const labels: Record<DesktopProfilePresence, string> = {
        online: _t("desktop|profile|presence_online"),
        unavailable: _t("desktop|profile|presence_unavailable"),
        offline: _t("desktop|profile|presence_offline"),
    };
    const label = labels[presence];
    return (
        <span className={styles.badge} role="img" aria-label={label} title={label} data-presence={presence}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
                {presence === "online" ? (
                    <circle cx="8" cy="8" r="7" fill="currentColor" />
                ) : presence === "unavailable" ? (
                    <path d="M15 8a7 7 0 1 1-7-7 5.5 5.5 0 0 0 7 7Z" fill="currentColor" />
                ) : (
                    <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="4" />
                )}
            </svg>
        </span>
    );
}

interface DesktopProfileBannerProps {
    identity: DesktopProfileIdentitySnapshot;
    size: "popout" | "full";
    /** Controls drawn over the top-right corner of the banner. */
    children?: ReactNode;
    /** Wraps the avatar when it should be interactive. */
    renderAvatar?: (avatar: JSX.Element) => ReactNode;
}

/**
 * Matrix has no profile banner, so the colour comes from the same hash of the user ID that tints their
 * fallback avatar. Nothing here is stored or invented.
 */
export function DesktopProfileBanner({
    identity,
    size,
    children,
    renderAvatar,
}: DesktopProfileBannerProps): JSX.Element {
    const colour = useIdColorHash(identity.userId);
    const avatar = (
        <Avatar
            id={identity.userId}
            name={identity.displayName}
            src={identity.avatarUrl}
            size={size === "popout" ? "80px" : "96px"}
            type="round"
        />
    );
    return (
        <div className={classNames(styles.banner, size === "popout" ? styles.popoutBanner : styles.fullBanner)}>
            <div className={styles.bannerColour} data-colour={colour} aria-hidden="true" />
            {children && <div className={styles.bannerActions}>{children}</div>}
            <div className={styles.avatarRing}>
                {renderAvatar ? renderAvatar(avatar) : avatar}
                {identity.presence && <PresenceBadge presence={identity.presence} />}
            </div>
        </div>
    );
}

interface DesktopProfileNamesProps {
    identity: DesktopProfileIdentitySnapshot;
    nameId?: string;
    /** Wraps the display name when it should be interactive. */
    renderName?: (name: JSX.Element) => ReactNode;
}

/** Display name, then the Matrix ID in the slot Discord uses for a username, then role chips. */
export function DesktopProfileNames({ identity, nameId, renderName }: DesktopProfileNamesProps): JSX.Element {
    const { translate: _t } = useI18n();
    const name = (
        <Text as="span" id={nameId} size="lg" weight="semibold" className={styles.displayName}>
            {identity.displayName}
        </Text>
    );
    return (
        <div className={styles.names}>
            <Text as="h2" size="lg" weight="semibold" className={styles.heading}>
                {renderName ? renderName(name) : name}
            </Text>
            <div className={styles.idRow}>
                <Text as="span" size="sm" className={styles.matrixId}>
                    {identity.userId}
                </Text>
                {identity.roles.length > 0 && (
                    <ul className={styles.roles} aria-label={_t("desktop|profile|roles")}>
                        {identity.roles.map((role) => (
                            <li key={role.key} className={styles.role}>
                                {role.label}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            {identity.status && (
                <Text as="p" size="sm" className={styles.status}>
                    <span aria-hidden="true">{identity.status.emoji}</span> {identity.status.text}
                </Text>
            )}
        </div>
    );
}
