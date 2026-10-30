/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    isHexColour,
    PROFILE_DECORATIONS,
    PROFILE_EFFECTS,
    PROFILE_NAME_EFFECTS,
    PROFILE_NAME_FONTS,
    PROFILE_NAMEPLATES,
    type ProfileDecorationId,
    type ProfileEffectId,
    type ProfileNameEffect,
    type ProfileNameFont,
    type ProfileNameplateId,
    type ProfileTheme,
    type UserStatus,
} from "@element-hq/web-shared-components";

/** Aether's own profile field (MSC4133). This is not part of the Matrix specification. */
export const RICH_PROFILE_FIELD = "io.aether.profile";
/** Fields other clients already use, so a banner, bio or pronouns set in Aether also show in Commet, Sable and gomuks. */
export const BANNER_FIELD = "chat.commet.profile_banner";
export const BIO_FIELD_MSC4440 = "gay.fomx.biography";
export const BIO_FIELD_COMMET = "chat.commet.profile_bio";
export const BIO_FIELD_SABLE = "moe.sable.app.bio";
export const NAME_COLOUR_FIELD = "moe.sable.app.name_color";
export const PRONOUNS_FIELD_UNSTABLE = "io.fsky.nyx.pronouns";
export const PRONOUNS_FIELD_STABLE = "m.pronouns";
export const STATUS_FIELD = "org.matrix.msc4426.status";
export const TIMEZONE_FIELDS = ["m.tz", "us.cloke.msc4175.tz"];

/** Fields that should reach other clients through sync where the server offers it (MSC4429). */
export const RICH_PROFILE_SYNC_FIELDS = [RICH_PROFILE_FIELD, BANNER_FIELD, BIO_FIELD_MSC4440, PRONOUNS_FIELD_UNSTABLE];

export const MAX_BIO_LENGTH = 500;
export const MAX_PRONOUNS_LENGTH = 40;
export const MAX_LINKS = 6;
export const MAX_LINK_LABEL_LENGTH = 40;
export const MAX_URL_LENGTH = 512;
export const MAX_BOARD_ITEMS = 8;
export const MAX_BOARD_TITLE_LENGTH = 40;
export const MAX_BOARD_ITEM_TITLE_LENGTH = 60;
export const MAX_BOARD_ITEM_CAPTION_LENGTH = 80;
/** The whole profile may not exceed 64 KiB, and it has to leave room for the other fields and other clients. */
export const MAX_RICH_FIELD_BYTES = 32 * 1024;

/** A built-in nameplate, or the person's own image. */
export type RichNameplate = { preset: ProfileNameplateId } | { mxc: string };

/** One tile of a person's board. */
export interface RichBoardItem {
    title: string;
    caption?: string;
    mxc?: string;
}

/** A link the person added themselves. */
export interface RichLink {
    label: string;
    url: string;
}

/** A person's profile after every field has been validated. Anything malformed is absent, never passed along. */
export interface RichProfile {
    bannerMxc?: string;
    /** The banner is animated, so its original should play rather than a still thumbnail. */
    bannerAnimated?: boolean;
    /** The avatar with this MXC URI is animated. Compared against the current avatar, so it cannot go stale. */
    animatedAvatarMxc?: string;
    bio?: string;
    pronouns?: string;
    status?: UserStatus;
    timezone?: string;
    theme?: ProfileTheme;
    decoration?: ProfileDecorationId;
    effect?: ProfileEffectId;
    nameplate?: RichNameplate;
    nameFont?: ProfileNameFont;
    nameEffect?: ProfileNameEffect;
    nameColour?: string;
    nameColourEnd?: string;
    links: RichLink[];
    boardTitle?: string;
    board: RichBoardItem[];
    /** The Space whose tag is worn. Only ever trusted after checking that Space's own state. */
    tagSpaceId?: string;
}

/** A profile with nothing set. */
export const EMPTY_RICH_PROFILE: RichProfile = { links: [], board: [] };

const MXC = /^mxc:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9_-]+$/;
const ROOM_ID = /^![^\s/]{1,255}$/;
// Bidirectional overrides can make a label read differently from what it says.
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the value is an MXC URI, the only way a profile may refer to media. External URLs would reveal viewers' IPs. */
export function isMxc(value: unknown): value is string {
    return typeof value === "string" && MXC.test(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
    return allowed.includes(value as T) ? (value as T) : undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const cleaned = value.replace(BIDI_CONTROLS, "").trim();
    return cleaned ? [...cleaned].slice(0, maxLength).join("") : undefined;
}

/**
 * Read a web address safely: http and https only, no embedded credentials.
 * @returns the normalised address and its host (which the URL parser has already converted from any lookalike
 * Unicode to punycode), or undefined if it is not usable.
 */
export function parseProfileUrl(value: unknown): { url: string; host: string } | undefined {
    if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(value.trim());
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return { url: parsed.href, host: parsed.host };
}

/** Other clients store bios as HTML. It is reduced to text here and never rendered as markup. */
function textFromHtml(html: string): string {
    const prepared = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
    // DOMParser builds an inert document: scripts do not run and images do not load.
    return new DOMParser().parseFromString(prepared, "text/html").body.textContent ?? "";
}

function parseBio(raw: Record<string, unknown>): string | undefined {
    const msc4440 = raw[BIO_FIELD_MSC4440];
    if (isObject(msc4440) && Array.isArray(msc4440["m.text"])) {
        const parts = msc4440["m.text"].filter(isObject);
        const plain = parts.find((part) => (part.mimetype ?? "text/plain") === "text/plain");
        if (typeof plain?.body === "string") return text(plain.body, MAX_BIO_LENGTH);
        const html = parts.find((part) => part.mimetype === "text/html");
        if (typeof html?.body === "string") return text(textFromHtml(html.body), MAX_BIO_LENGTH);
    }
    const commet = raw[BIO_FIELD_COMMET];
    if (isObject(commet)) {
        if (typeof commet.body === "string") return text(commet.body, MAX_BIO_LENGTH);
        if (typeof commet.formatted_body === "string") {
            return text(textFromHtml(commet.formatted_body), MAX_BIO_LENGTH);
        }
    }
    const sable = raw[BIO_FIELD_SABLE];
    return typeof sable === "string" ? text(textFromHtml(sable), MAX_BIO_LENGTH) : undefined;
}

function parsePronouns(raw: Record<string, unknown>): string | undefined {
    const value = raw[PRONOUNS_FIELD_STABLE] ?? raw[PRONOUNS_FIELD_UNSTABLE];
    if (!Array.isArray(value)) return undefined;
    // The list is ordered by preference, and may hold several languages. The first entry is the one to show.
    const summaries = value.filter(isObject).map((entry) => text(entry.summary, MAX_PRONOUNS_LENGTH));
    return summaries.find(Boolean);
}

function parseStatus(raw: Record<string, unknown>): UserStatus | undefined {
    const value = raw[STATUS_FIELD];
    if (!isObject(value)) return undefined;
    const statusText = text(value.text, 128);
    if (!statusText || typeof value.emoji !== "string" || !value.emoji) return undefined;
    const emoji = [...new Intl.Segmenter().segment(value.emoji)][0]?.segment;
    return emoji ? { emoji, text: statusText } : undefined;
}

function parseTimezone(raw: Record<string, unknown>): string | undefined {
    for (const field of TIMEZONE_FIELDS) {
        const value = raw[field];
        if (typeof value !== "string") continue;
        try {
            // Constructing the format is what validates the timezone.
            return new Intl.DateTimeFormat(undefined, { timeZone: value }).resolvedOptions().timeZone && value;
        } catch {
            // An unknown timezone is the same as none.
        }
    }
    return undefined;
}

function parseLinks(value: unknown): RichLink[] {
    if (!Array.isArray(value)) return [];
    const links: RichLink[] = [];
    for (const entry of value) {
        if (links.length >= MAX_LINKS) break;
        if (!isObject(entry)) continue;
        const parsed = parseProfileUrl(entry.url);
        if (!parsed) continue;
        links.push({ label: text(entry.label, MAX_LINK_LABEL_LENGTH) ?? parsed.host, url: parsed.url });
    }
    return links;
}

function parseBoard(value: unknown): Pick<RichProfile, "boardTitle" | "board"> {
    if (!isObject(value) || !Array.isArray(value.items)) return { board: [] };
    const board: RichBoardItem[] = [];
    for (const entry of value.items) {
        if (board.length >= MAX_BOARD_ITEMS) break;
        if (!isObject(entry)) continue;
        const title = text(entry.title, MAX_BOARD_ITEM_TITLE_LENGTH);
        const mxc = isMxc(entry.mxc) ? entry.mxc : undefined;
        if (!title && !mxc) continue;
        board.push({ title: title ?? "", caption: text(entry.caption, MAX_BOARD_ITEM_CAPTION_LENGTH), mxc });
    }
    return { boardTitle: text(value.title, MAX_BOARD_TITLE_LENGTH), board };
}

/**
 * Turn a person's raw profile fields into something safe to draw. Every value is untrusted: it came from whoever owns
 * the account, through whichever server they use.
 */
export function parseRichProfile(raw: Record<string, unknown>): RichProfile {
    const ownField = raw[RICH_PROFILE_FIELD];
    const own = isObject(ownField) ? ownField : {};
    const theme = isObject(own.theme) ? own.theme : undefined;
    const name = isObject(own.name) ? own.name : {};
    const plate = isObject(own.nameplate) ? own.nameplate : {};
    const nameplatePreset = oneOf(PROFILE_NAMEPLATES, plate.preset);
    const otherNameColour = raw[NAME_COLOUR_FIELD];
    const nameColour = isHexColour(name.colour)
        ? name.colour
        : isHexColour(otherNameColour)
          ? otherNameColour
          : undefined;
    const banner = raw[BANNER_FIELD];

    return {
        bannerMxc: isMxc(banner) ? banner : undefined,
        bannerAnimated: own.banner_animated === true || undefined,
        animatedAvatarMxc: isMxc(own.animated_avatar) ? own.animated_avatar : undefined,
        bio: parseBio(raw),
        pronouns: parsePronouns(raw),
        status: parseStatus(raw),
        timezone: parseTimezone(raw),
        theme:
            theme && isHexColour(theme.primary) && isHexColour(theme.accent)
                ? { primary: theme.primary, accent: theme.accent }
                : undefined,
        decoration: oneOf(PROFILE_DECORATIONS, own.decoration),
        effect: oneOf(PROFILE_EFFECTS, own.effect),
        nameplate: nameplatePreset ? { preset: nameplatePreset } : isMxc(plate.mxc) ? { mxc: plate.mxc } : undefined,
        nameFont: oneOf(PROFILE_NAME_FONTS, name.font),
        nameEffect: oneOf(PROFILE_NAME_EFFECTS, name.effect),
        nameColour,
        nameColourEnd: isHexColour(name.colour_end) ? name.colour_end : undefined,
        links: parseLinks(own.links),
        ...parseBoard(own.board),
        tagSpaceId: typeof own.tag === "string" && ROOM_ID.test(own.tag) ? own.tag : undefined,
    };
}

/** Drop undefined values and empty containers, so an unset profile stores nothing at all. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter(
            ([, entry]) =>
                entry !== undefined &&
                !(Array.isArray(entry) && entry.length === 0) &&
                !(isObject(entry) && Object.keys(entry).length === 0),
        ),
    );
}

/** Aether's field for this profile, or undefined when there is nothing to store. Unknown keys from newer clients stay. */
export function serialiseRichField(profile: RichProfile, existing?: unknown): Record<string, unknown> | undefined {
    const preserved: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
    const known = compact({
        banner_animated: profile.bannerMxc && profile.bannerAnimated ? true : undefined,
        animated_avatar: profile.animatedAvatarMxc,
        theme: profile.theme,
        decoration: profile.decoration,
        effect: profile.effect,
        nameplate: profile.nameplate,
        name: compact({
            font: profile.nameFont && profile.nameFont !== "default" ? profile.nameFont : undefined,
            effect: profile.nameEffect && profile.nameEffect !== "none" ? profile.nameEffect : undefined,
            colour: profile.nameColour,
            colour_end: profile.nameColourEnd,
        }),
        links: profile.links,
        board: profile.board.length
            ? compact({
                  title: profile.boardTitle,
                  items: profile.board.map((item) => compact({ ...item, caption: item.caption || undefined })),
              })
            : undefined,
        tag: profile.tagSpaceId,
    });
    for (const key of [
        "v",
        "banner_animated",
        "animated_avatar",
        "theme",
        "decoration",
        "effect",
        "nameplate",
        "name",
        "links",
        "board",
        "tag",
    ]) {
        delete preserved[key];
    }
    if (!Object.keys(known).length && !Object.keys(preserved).length) return undefined;
    return { v: 1, ...preserved, ...known };
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("\n", "<br/>");
}

/** JSON that is the same however an object's keys are ordered, because a server may return them in another order. */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, entry) =>
        isObject(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry,
    );
}

/** One change to make to the stored profile. A null value deletes the field. */
export interface ProfileFieldWrite {
    key: string;
    value: unknown;
}

/**
 * Work out the smallest set of field changes that turns `current` into `next`. A bio goes to all three fields clients
 * read it from, so whichever one another client prefers is never stale.
 */
export function buildProfileWrites(
    raw: Record<string, unknown>,
    current: RichProfile,
    next: RichProfile,
    language: string,
): ProfileFieldWrite[] {
    const writes: ProfileFieldWrite[] = [];
    const ownField = serialiseRichField(next, raw[RICH_PROFILE_FIELD]);
    if (canonicalJson(ownField) !== canonicalJson(raw[RICH_PROFILE_FIELD])) {
        writes.push({ key: RICH_PROFILE_FIELD, value: ownField ?? null });
    }
    if (next.bannerMxc !== current.bannerMxc) writes.push({ key: BANNER_FIELD, value: next.bannerMxc ?? null });
    if (next.bio !== current.bio) {
        if (next.bio) {
            const html = escapeHtml(next.bio);
            writes.push(
                { key: BIO_FIELD_MSC4440, value: { "m.text": [{ body: next.bio, mimetype: "text/plain" }] } },
                { key: BIO_FIELD_COMMET, value: { format: "org.matrix.custom.html", formatted_body: html } },
                { key: BIO_FIELD_SABLE, value: html },
            );
        } else {
            writes.push(
                { key: BIO_FIELD_MSC4440, value: null },
                { key: BIO_FIELD_COMMET, value: null },
                { key: BIO_FIELD_SABLE, value: null },
            );
        }
    }
    if (next.pronouns !== current.pronouns) {
        writes.push({
            key: PRONOUNS_FIELD_UNSTABLE,
            value: next.pronouns ? [{ language, summary: next.pronouns }] : null,
        });
    }
    if (next.nameColour !== current.nameColour) {
        writes.push({ key: NAME_COLOUR_FIELD, value: next.nameColour ?? null });
    }
    return writes;
}

/** The size of Aether's field when stored. */
export function richFieldBytes(profile: RichProfile): number {
    return new TextEncoder().encode(JSON.stringify(serialiseRichField(profile) ?? {})).length;
}
