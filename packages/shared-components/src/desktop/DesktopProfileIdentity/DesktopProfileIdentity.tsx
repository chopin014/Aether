/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, {
    createContext,
    type CSSProperties,
    type JSX,
    type ReactNode,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import classNames from "classnames";
import { Avatar, Text, useIdColorHash } from "@vector-im/compound-web";

import { useI18n } from "../../core/i18n/i18nContext";
import { type UserStatus } from "../../core/userStatus";
import { PresenceGlyph } from "../../presence/PresenceGlyph";
import {
    type DesktopProfileAppearance,
    ProfileDecoration,
    ProfileEffectLayer,
    ProfileName,
    profileThemeStyle,
    useProfileMotion,
} from "../ProfileAppearance";
import styles from "./DesktopProfileIdentity.module.css";

/** Presence the server has actually reported; unknown presence is represented by omitting it. */
export type DesktopProfilePresence = "online" | "unavailable" | "offline";

/** A Matrix power-level role shown where Discord shows server roles. */
export interface DesktopProfileRole {
    key: string;
    label: string;
}

/** A link the person added to their own profile. Nothing has verified that they own it. */
export interface DesktopProfileLink {
    url: string;
    label: string;
    /** The real destination, always shown so a label cannot disguise where it leads. */
    host: string;
}

/** A label a Space administrator defines and a member of that Space chooses to wear. */
export interface DesktopProfileTag {
    label: string;
    emoji?: string;
    /** `#rrggbb` chosen by the Space's administrators. */
    colour?: string;
    spaceName: string;
}

/** Who the profile is about, shared by the popout card, the full profile and the editor's preview. */
export interface DesktopProfileIdentitySnapshot {
    userId: string;
    displayName: string;
    avatarUrl?: string;
    presence?: DesktopProfilePresence;
    roles: DesktopProfileRole[];
    /** The user's extended-profile status, when the server provides one. */
    status?: UserStatus;
    /** How the person chose to present their profile. */
    appearance?: DesktopProfileAppearance;
    pronouns?: string;
    bio?: string;
    links?: DesktopProfileLink[];
    tag?: DesktopProfileTag;
    /** The time where the person is, formatted for the viewer, when they share a timezone. */
    localTime?: string;
}

/** Whether the surrounding surface is active, which is when animated media plays. */
const ProfileLiveContext = createContext(false);

interface DesktopProfileSurfaceProps {
    identity: Pick<DesktopProfileIdentitySnapshot, "appearance" | "userId">;
    className?: string;
    /** Play the card's animation when it opens, rather than only on hover. */
    intro?: boolean;
    /** Marks a large surface, which also draws the banner blurred behind everything. */
    backdrop?: boolean;
    children: ReactNode;
}

/**
 * The themed ground of a profile card. It redefines the Compound colour tokens for everything inside, so buttons,
 * chips and text all stay readable on whichever colours the person picked.
 */
export function DesktopProfileSurface({
    identity,
    className,
    intro = true,
    backdrop,
    children,
}: DesktopProfileSurfaceProps): JSX.Element {
    const { appearance, userId } = identity;
    const motion = useProfileMotion(intro);
    const themed = useMemo(() => (appearance?.theme ? profileThemeStyle(appearance.theme) : undefined), [appearance]);
    const backdropImage = backdrop ? appearance?.bannerUrl : undefined;
    return (
        <ProfileLiveContext.Provider value={motion.live}>
            <div
                {...motion.bind}
                className={classNames(styles.surface, className)}
                data-tone={themed?.tone}
                style={{ ...motion.bind.style, ...themed?.style }}
            >
                {backdropImage && (
                    <img className={styles.backdrop} src={backdropImage} alt="" aria-hidden="true" loading="lazy" />
                )}
                {appearance?.effect && (
                    // Fades away when the card goes quiet, rather than leaving frozen particles over the text.
                    <div className={styles.effectHost} data-live={motion.live}>
                        <ProfileEffectLayer id={appearance.effect} seed={userId} />
                    </div>
                )}
                {children}
            </div>
        </ProfileLiveContext.Provider>
    );
}

/** Whether the profile surface around this component is active. */
export function useProfileLive(): boolean {
    return useContext(ProfileLiveContext);
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
            <PresenceGlyph status={presence} />
        </span>
    );
}

/**
 * The average colour of an avatar, which gives a plain banner something that belongs to its owner. Images a canvas
 * may not read (a media server without CORS headers) leave this undefined and the ID's colour takes over.
 */
export function useDominantColour(url: string | undefined, enabled: boolean): string | undefined {
    const [colour, setColour] = useState<string>();
    useEffect(() => {
        setColour(undefined);
        if (!url || !enabled) return;
        let cancelled = false;
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
            if (cancelled) return;
            try {
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = 8;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) return;
                context.drawImage(image, 0, 0, 8, 8);
                const { data } = context.getImageData(0, 0, 8, 8);
                const total = [0, 0, 0];
                for (let i = 0; i < data.length; i += 4) {
                    total[0] += data[i];
                    total[1] += data[i + 1];
                    total[2] += data[i + 2];
                }
                const [r, g, b] = total.map((value) => Math.round(value / (data.length / 4)));
                setColour(`rgb(${r} ${g} ${b})`);
            } catch {
                // A tainted canvas: the ID's colour is the fallback.
            }
        };
        image.src = url;
        return () => {
            cancelled = true;
        };
    }, [url, enabled]);
    return colour;
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
 * Banner, avatar, decoration and status bubble. Without a banner image the colour comes from the theme, then the
 * avatar, then the same hash of the user ID that tints their fallback avatar.
 */
export function DesktopProfileBanner({
    identity,
    size,
    children,
    renderAvatar,
}: DesktopProfileBannerProps): JSX.Element {
    const live = useProfileLive();
    const { appearance } = identity;
    const hashColour = useIdColorHash(identity.userId);
    const dominant = useDominantColour(identity.avatarUrl, !appearance?.bannerUrl && !appearance?.theme);
    const [animatedBannerReady, setAnimatedBannerReady] = useState(false);
    const animatedBanner = live ? appearance?.bannerAnimatedUrl : undefined;
    const bannerColour = (dominant ? { "--desktop-profile-banner": dominant } : undefined) as CSSProperties | undefined;

    const avatar = (
        <Avatar
            id={identity.userId}
            name={identity.displayName}
            src={(live && appearance?.avatarAnimatedUrl) || identity.avatarUrl}
            size={size === "popout" ? "80px" : "120px"}
            type="round"
        />
    );
    return (
        <div className={classNames(styles.banner, size === "popout" ? styles.popoutBanner : styles.fullBanner)}>
            <div className={styles.bannerColour} data-colour={hashColour} style={bannerColour} aria-hidden="true">
                {appearance?.bannerUrl && (
                    <img className={styles.bannerImage} src={appearance.bannerUrl} alt="" loading="lazy" />
                )}
                {animatedBanner && (
                    <img
                        className={styles.bannerImage}
                        data-ready={animatedBannerReady}
                        src={animatedBanner}
                        alt=""
                        onLoad={() => setAnimatedBannerReady(true)}
                    />
                )}
            </div>
            {children && <div className={styles.bannerActions}>{children}</div>}
            <div className={styles.avatarRing}>
                <div className={styles.avatarBox}>
                    {renderAvatar ? renderAvatar(avatar) : avatar}
                    {appearance?.decoration && <ProfileDecoration id={appearance.decoration} />}
                </div>
                {identity.presence && <PresenceBadge presence={identity.presence} />}
            </div>
            {identity.status && (
                <Text as="p" size="sm" className={styles.statusBubble} title={identity.status.text}>
                    <span aria-hidden="true">{identity.status.emoji}</span> <span>{identity.status.text}</span>
                </Text>
            )}
        </div>
    );
}

interface DesktopProfileTagChipProps {
    tag: DesktopProfileTag;
}

/** A Space's tag, as worn by one of its members. */
export function DesktopProfileTagChip({ tag }: DesktopProfileTagChipProps): JSX.Element {
    const { translate: _t } = useI18n();
    const style = (tag.colour ? { "--profile-tag": tag.colour } : undefined) as CSSProperties | undefined;
    return (
        <span className={styles.tag} style={style} title={_t("desktop|profile|tag_from", { space: tag.spaceName })}>
            {tag.emoji && <span aria-hidden="true">{tag.emoji}</span>}
            {tag.label}
        </span>
    );
}

interface DesktopProfileNamesProps {
    identity: DesktopProfileIdentitySnapshot;
    nameId?: string;
    /** Wraps the display name when it should be interactive. */
    renderName?: (name: JSX.Element) => ReactNode;
    /** The larger type used by the full profile. */
    large?: boolean;
}

/** Display name, then the Matrix ID in the slot Discord uses for a username, pronouns and the worn tag. */
export function DesktopProfileNames({ identity, nameId, renderName, large }: DesktopProfileNamesProps): JSX.Element {
    const name = (
        <Text as="span" id={nameId} size="lg" weight="semibold" className={styles.displayName}>
            <ProfileName nameStyle={identity.appearance?.nameStyle}>{identity.displayName}</ProfileName>
        </Text>
    );
    return (
        <div className={styles.names} data-large={large}>
            <Text as="h2" size="lg" weight="semibold" className={styles.heading}>
                {renderName ? renderName(name) : name}
            </Text>
            <div className={styles.idRow}>
                <Text as="span" size="sm" className={styles.matrixId}>
                    {identity.userId}
                </Text>
                {identity.pronouns && (
                    <Text as="span" size="sm" className={styles.pronouns}>
                        {identity.pronouns}
                    </Text>
                )}
                {identity.tag && <DesktopProfileTagChip tag={identity.tag} />}
            </div>
        </div>
    );
}

interface DesktopProfileRolesProps {
    roles: DesktopProfileRole[];
}

/** The person's role chips. */
export function DesktopProfileRoles({ roles }: DesktopProfileRolesProps): JSX.Element | null {
    const { translate: _t } = useI18n();
    if (!roles.length) return null;
    return (
        <ul className={styles.roles} aria-label={_t("desktop|profile|roles")}>
            {roles.map((role) => (
                <li key={role.key} className={styles.role}>
                    <span className={styles.roleDot} aria-hidden="true" />
                    {role.label}
                </li>
            ))}
        </ul>
    );
}

const LINK = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])/g;

/** Plain text with its web addresses made clickable. Nothing in a bio is ever interpreted as markup. */
function BioText({ text }: { text: string }): JSX.Element {
    // Splitting on a captured pattern puts the matches at the odd positions.
    const parts = text.split(LINK).map((part, position) => ({ part, position }));
    return (
        <>
            {parts.map(({ part, position }) =>
                position % 2 ? (
                    <a key={position} href={part} target="_blank" rel="noreferrer noopener">
                        {part}
                    </a>
                ) : (
                    part
                ),
            )}
        </>
    );
}

/** Beyond this the popout folds the bio away behind "View full bio". */
const BIO_FOLD_CHARACTERS = 150;

interface DesktopProfileBioProps {
    bio: string;
    /** When given, a long bio is folded and this opens the rest. */
    onViewFull?: () => void;
}

/** The person's own words. */
export function DesktopProfileBio({ bio, onViewFull }: DesktopProfileBioProps): JSX.Element {
    const { translate: _t } = useI18n();
    const folded = !!onViewFull && (bio.length > BIO_FOLD_CHARACTERS || bio.split("\n").length > 3);
    return (
        <div className={styles.bio}>
            <Text as="p" size="sm" className={styles.bioText} data-folded={folded}>
                <BioText text={bio} />
            </Text>
            {folded && (
                <button type="button" className={styles.bioMore} onClick={onViewFull}>
                    {_t("desktop|profile|view_full_bio")}
                </button>
            )}
        </div>
    );
}
