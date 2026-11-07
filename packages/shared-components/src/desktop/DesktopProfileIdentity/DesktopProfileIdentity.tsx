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
import VolumeOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/volume-on";

import { useI18n } from "../../core/i18n/i18nContext";
import { type UserStatus } from "../../core/userStatus";
import { PresenceGlyph } from "../../presence/PresenceGlyph";
import {
    type DesktopProfileAppearance,
    ProfileDecoration,
    ProfileEffectLayer,
    ProfileName,
    profileThemeStyle,
    ProfileLiveContext,
    useProfileLive,
    imageFrameStyle,
    useImageColour,
    useProfileMotion,
} from "../ProfileAppearance";
import styles from "./DesktopProfileIdentity.module.css";

/** Presence shown on a profile; the host maps unknown status to offline. */
export type DesktopProfilePresence = "online" | "unavailable" | "busy" | "offline";

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

/** A person, room or Space shown as a small round picture. */
export interface DesktopProfileFace {
    id: string;
    name: string;
    avatarUrl?: string;
}

/**
 * What the person is doing right now, shown as a card on their profile. Voice comes from the MatrixRTC calls the
 * viewer can see; games will join it as another kind.
 */
export interface DesktopProfileActivity {
    kind: "voice";
    /** The voice channel's room. */
    roomId: string;
    channelName: string;
    /** The Space the channel belongs to, when there is one. */
    spaceName?: string;
    /** Everyone in the channel. */
    count: number;
    /** The first few of them, to show their faces. */
    people: DesktopProfileFace[];
}

/** Spaces the viewer shares with the person, from members this client already knows. */
export interface DesktopProfileMutual {
    count: number;
    /** The first few, to show their icons. */
    faces: DesktopProfileFace[];
}

/** Who the profile is about, shared by the popout card, the full profile and the editor's preview. */
export interface DesktopProfileIdentitySnapshot {
    userId: string;
    displayName: string;
    avatarUrl?: string;
    /**
     * A smaller image of the same avatar that has already loaded elsewhere. It is shown, and gives the banner its
     * colour, until `avatarUrl` has loaded, so the card never opens with an empty avatar.
     */
    avatarPreviewUrl?: string;
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
    /** What the person is doing right now. */
    activity?: DesktopProfileActivity;
    /** Spaces both people are in. Omitted on the viewer's own profile. */
    mutual?: DesktopProfileMutual;
}

/** Whether motion is allowed in the card at all: open, in a focused window, without reduced motion. */
const ProfileMotionAllowedContext = createContext(false);

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
            <ProfileMotionAllowedContext.Provider value={motion.allowed}>
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
                        <ProfileEffectLayer
                            id={appearance.effect}
                            seed={userId}
                            live={motion.allowed}
                            // A card steps its effect back while it is being read. A full profile fills the whole
                            // dialog, so dimming there would fade the effect in and out with every pointer movement.
                            dimmed={motion.hovered && !backdrop}
                        />
                    )}
                    {children}
                </div>
            </ProfileMotionAllowedContext.Provider>
        </ProfileLiveContext.Provider>
    );
}

export { useProfileLive };

interface PresenceBadgeProps {
    presence: DesktopProfilePresence;
}

/** Presence mark with a canvas-coloured ring so it reads as cut out of the avatar. */
function PresenceBadge({ presence }: PresenceBadgeProps): JSX.Element {
    const { translate: _t } = useI18n();
    const labels: Record<DesktopProfilePresence, string> = {
        online: _t("desktop|profile|presence_online"),
        unavailable: _t("desktop|profile|presence_unavailable"),
        busy: _t("desktop|profile|presence_busy"),
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
 * The colour that best represents an avatar: its most common vivid hue rather than the muddy average of every pixel,
 * so a plain banner takes the colour people associate with its owner, as Discord's does. Images a canvas may not read
 * (a media server without CORS headers) leave this undefined and the ID's colour takes over.
 */
export function useDominantColour(url: string | undefined, enabled: boolean): string | undefined {
    return useImageColour(url, enabled);
}

/** Show `preview` until `url` has finished loading, then `url`. Without a preview this is simply `url`. */
export function useProgressiveImage(url: string | undefined, preview: string | undefined): string | undefined {
    const [loaded, setLoaded] = useState<string>();
    useEffect(() => {
        if (!url || !preview || url === preview) return;
        let cancelled = false;
        const image = new Image();
        image.onload = () => {
            if (!cancelled) setLoaded(url);
        };
        image.src = url;
        return () => {
            cancelled = true;
        };
    }, [url, preview]);
    return preview && loaded !== url ? preview : url;
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
    const motionAllowed = useContext(ProfileMotionAllowedContext);
    const { appearance } = identity;
    const hashColour = useIdColorHash(identity.userId);
    // The preview is already decoded, so sampling it gives the banner its colour at once rather than after a load.
    const dominant = useDominantColour(
        identity.avatarPreviewUrl ?? identity.avatarUrl,
        !appearance?.bannerUrl && !appearance?.theme,
    );
    const avatarUrl = useProgressiveImage(identity.avatarUrl, identity.avatarPreviewUrl);
    const [animatedBannerReady, setAnimatedBannerReady] = useState(false);
    // An animated banner plays for as long as the card is open, as Discord's does, not only while it is hovered.
    const animatedBanner = motionAllowed ? appearance?.bannerAnimatedUrl : undefined;
    const bannerFrame = imageFrameStyle(appearance?.bannerFrame) as CSSProperties | undefined;
    const bannerColour = (dominant ? { "--desktop-profile-banner": dominant } : undefined) as CSSProperties | undefined;

    const avatar = (
        <Avatar
            id={identity.userId}
            name={identity.displayName}
            src={(live && appearance?.avatarAnimatedUrl) || avatarUrl}
            size={size === "popout" ? "80px" : "120px"}
            type="round"
        />
    );
    return (
        <div className={classNames(styles.banner, size === "popout" ? styles.popoutBanner : styles.fullBanner)}>
            <div
                className={styles.bannerColour}
                data-colour={hashColour}
                data-from-avatar={!!dominant}
                style={bannerColour}
                aria-hidden="true"
            >
                {appearance?.bannerUrl && (
                    <img
                        className={styles.bannerImage}
                        src={appearance.bannerUrl}
                        alt=""
                        loading="lazy"
                        style={bannerFrame}
                    />
                )}
                {animatedBanner && (
                    <img
                        className={styles.bannerImage}
                        data-ready={animatedBannerReady}
                        src={animatedBanner}
                        alt=""
                        style={bannerFrame}
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

/** Faces overlapping one another, each ringed in the card's colour so they read as separate. */
function FaceStack({ faces, size }: { faces: DesktopProfileFace[]; size: "16px" | "20px" }): JSX.Element {
    return (
        <span className={styles.faces} aria-hidden="true">
            {faces.map((face) => (
                <span key={face.id} className={styles.face}>
                    <Avatar id={face.id} name={face.name} src={face.avatarUrl} size={size} type="round" />
                </span>
            ))}
        </span>
    );
}

/** "3 mutual Spaces", with their icons, as Discord shows mutual friends and servers. */
export function DesktopProfileMutualLine({ mutual }: { mutual: DesktopProfileMutual }): JSX.Element | null {
    const { translate: _t } = useI18n();
    if (!mutual.count) return null;
    return (
        <Text as="p" size="sm" className={styles.mutual}>
            <FaceStack faces={mutual.faces} size="16px" />
            {_t("desktop|profile|mutual_spaces_count", { count: mutual.count })}
        </Text>
    );
}

interface DesktopProfileActivityCardProps {
    activity: DesktopProfileActivity;
    /** Join the channel. Omitted on the viewer's own profile. */
    onJoin?: () => void;
}

/** Where the person is right now and who is with them, with a way to join them, like Discord's "In voice" card. */
export function DesktopProfileActivityCard({ activity, onJoin }: DesktopProfileActivityCardProps): JSX.Element {
    const { translate: _t } = useI18n();
    const others = activity.count - activity.people.length;
    return (
        <section className={styles.activity} aria-label={_t("desktop|profile|in_voice")}>
            <Text as="h3" size="xs" weight="semibold" className={styles.activityHeading}>
                {_t("desktop|profile|in_voice")}
            </Text>
            <div className={styles.activityBody}>
                <span
                    className={styles.activityFaces}
                    data-count={Math.min(4, activity.people.length)}
                    aria-hidden="true"
                >
                    {activity.people.slice(0, 4).map((person) => (
                        <Avatar
                            key={person.id}
                            id={person.id}
                            name={person.name}
                            src={person.avatarUrl}
                            size="24px"
                            type="round"
                        />
                    ))}
                </span>
                <div className={styles.activityText}>
                    <Text as="p" size="sm" weight="semibold" className={styles.activityTitle}>
                        <VolumeOnIcon aria-hidden="true" width="16px" height="16px" />
                        <span>{activity.channelName}</span>
                    </Text>
                    <Text as="p" size="xs" className={styles.activityDetail}>
                        {activity.spaceName
                            ? _t("desktop|profile|in_space", { space: activity.spaceName })
                            : _t("desktop|profile|people_in_voice", { count: activity.count })}
                        {others > 0 && activity.spaceName && ` · +${others}`}
                    </Text>
                </div>
            </div>
            {onJoin && (
                <button type="button" className={styles.activityJoin} onClick={onJoin}>
                    {_t("desktop|profile|join_voice")}
                </button>
            )}
        </section>
    );
}
