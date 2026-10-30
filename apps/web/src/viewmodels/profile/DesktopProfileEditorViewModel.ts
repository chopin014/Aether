/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    PROFILE_NAME_EFFECTS,
    PROFILE_NAME_FONTS,
    type DesktopProfileAppearance,
    type DesktopProfileEditorDraft,
    type DesktopProfileEditorViewActions,
    type DesktopProfileEditorViewSnapshot,
    type DesktopProfileIdentitySnapshot,
} from "@element-hq/web-shared-components";
import { MatrixError, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { _t, getCurrentLanguage } from "../../languageHandler";
import { mediaFromMxc } from "../../customisations/Media";
import {
    buildProfileWrites,
    EMPTY_RICH_PROFILE,
    MAX_BOARD_ITEMS,
    MAX_LINKS,
    MAX_RICH_FIELD_BYTES,
    parseProfileUrl,
    parseRichProfile,
    richFieldBytes,
    RICH_PROFILE_FIELD,
    type RichBoardItem,
    type RichNameplate,
    type RichProfile,
} from "../../profile/richProfile";
import { RichProfileStore } from "../../profile/RichProfileStore";
import { nameStyleFromRichProfile } from "../../profile/richProfileView";
import { spaceTagOptions } from "../../profile/spaceTag";
import { clearAllUserStatus, setUserStatus } from "../../utils/userStatus";

/** Images a profile can use. Animated formats are shown from the original file, not a still thumbnail. */
const ANIMATED_TYPES = new Set(["image/gif", "image/webp", "image/apng"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** How long to wait for a rate limit to lift before giving the person the error instead. */
const MAX_RETRY_WAIT_MS = 10 * 1000;

/** Decides whether a profile field may be changed. */
type FieldPermission = (key: string) => boolean;

/** Read the homeserver's rules for changing profile fields. */
function fieldPermission(
    capability: { enabled?: boolean; allowed?: string[]; disallowed?: string[] } | undefined,
): FieldPermission {
    return (key) => {
        if (!capability) return true;
        if (capability.enabled === false) return false;
        if (capability.allowed) return capability.allowed.includes(key);
        return !capability.disallowed?.includes(key);
    };
}

/** An image picked in the editor and not uploaded yet. */
interface PendingImage {
    file: File;
    previewUrl: string;
}

/** A board tile in the editor, whose image may not be uploaded yet. */
interface EditorBoardItem {
    id: string;
    title: string;
    caption: string;
    mxc?: string;
    pending?: PendingImage;
}

/** Matrix dependencies for the profile editor. */
export interface DesktopProfileEditorViewModelProps {
    client: MatrixClient;
}

/**
 * Backs the profile editor: holds the draft, shows it live in the preview, and writes only what changed when the
 * person presses Save. A failed save keeps the draft and what already went through, so trying again finishes the rest.
 */
export class DesktopProfileEditorViewModel
    extends BaseViewModel<DesktopProfileEditorViewSnapshot, DesktopProfileEditorViewModelProps>
    implements DesktopProfileEditorViewActions
{
    private store: RichProfileStore;
    private raw: Record<string, unknown> = {};
    private baseline: RichProfile = EMPTY_RICH_PROFILE;
    private baselineName = "";
    private baselineAvatarMxc?: string;

    private avatarMxc?: string;
    private pendingAvatar?: PendingImage;
    private bannerMxc?: string;
    private bannerAnimated?: boolean;
    private pendingBanner?: PendingImage;
    private nameplateMxc?: string;
    private pendingNameplate?: PendingImage;
    private board: EditorBoardItem[] = [];
    private nextId = 0;
    private canWrite: FieldPermission = () => true;

    public constructor(props: DesktopProfileEditorViewModelProps) {
        const userId = props.client.getSafeUserId();
        super(props, {
            state: "loading",
            draft: {
                displayName: "",
                pronouns: "",
                bio: "",
                statusEmoji: "",
                statusText: "",
                hasNameplateImage: false,
                nameStyle: { font: "default", effect: "none" },
                links: [],
                boardTitle: "",
                board: [],
            },
            preview: { userId, displayName: userId, roles: [] },
            hasBanner: false,
            hasAvatar: false,
            canSetDisplayName: false,
            canSetAvatar: false,
            tagOptions: [],
            dirty: false,
            saving: false,
            saved: false,
            tooLarge: false,
            maxLinks: MAX_LINKS,
            maxBoardItems: MAX_BOARD_ITEMS,
        });
        this.store = RichProfileStore.forClient(props.client);
        this.disposables.track(() => this.revokePreviews());
        void this.load();
    }

    private load = async (): Promise<void> => {
        const { client } = this.props;
        const userId = client.getSafeUserId();
        try {
            if (!(await client.doesServerSupportExtendedProfiles())) {
                if (!this.isDisposed) this.snapshot.merge({ state: "unsupported" });
                return;
            }
            const capabilities = (await client.getCapabilities()) ?? {};
            const capability = capabilities["m.profile_fields"] ?? capabilities["uk.tcpip.msc4133.profile_fields"];
            this.canWrite = fieldPermission(capability);
            if (!this.canWrite(RICH_PROFILE_FIELD)) {
                if (!this.isDisposed) this.snapshot.merge({ state: "read_only" });
                return;
            }
            // Fresh rather than cached: saving against stale values could overwrite a change from another device.
            this.raw = await client.getExtendedProfile(userId);
            if (this.isDisposed) return;
            const canSetDisplayName =
                this.canWrite("displayname") && capabilities["m.set_displayname"]?.enabled !== false;
            const canSetAvatar = this.canWrite("avatar_url") && capabilities["m.set_avatar_url"]?.enabled !== false;
            this.store.set(userId, this.raw);
            this.baseline = parseRichProfile(this.raw);
            this.baselineName = typeof this.raw.displayname === "string" ? this.raw.displayname : "";
            this.baselineAvatarMxc = typeof this.raw.avatar_url === "string" ? this.raw.avatar_url : undefined;
            this.adoptBaseline();
            this.snapshot.merge({
                state: "ready",
                canSetDisplayName,
                canSetAvatar,
                tagOptions: spaceTagOptions(client),
            });
        } catch (error) {
            if (error instanceof MatrixError && error.errcode === "M_NOT_FOUND") {
                this.adoptBaseline();
                if (!this.isDisposed) {
                    this.snapshot.merge({ state: "ready", canSetDisplayName: true, canSetAvatar: true });
                }
                return;
            }
            logger.warn("Could not load the profile to edit", error);
            if (!this.isDisposed) this.snapshot.merge({ state: "unsupported" });
        }
    };

    /** Make the draft match what is stored, discarding anything unsaved. */
    private adoptBaseline(): void {
        const profile = this.baseline;
        this.revokePreviews();
        this.avatarMxc = this.baselineAvatarMxc;
        this.bannerMxc = profile.bannerMxc;
        this.bannerAnimated = profile.bannerAnimated;
        this.nameplateMxc = profile.nameplate && "mxc" in profile.nameplate ? profile.nameplate.mxc : undefined;
        this.board = profile.board.map((item) => ({
            id: this.newId(),
            title: item.title,
            caption: item.caption ?? "",
            mxc: item.mxc,
        }));
        const draft: DesktopProfileEditorDraft = {
            displayName: this.baselineName,
            pronouns: profile.pronouns ?? "",
            bio: profile.bio ?? "",
            statusEmoji: profile.status?.emoji ?? "",
            statusText: profile.status?.text ?? "",
            theme: profile.theme,
            decoration: profile.decoration,
            effect: profile.effect,
            nameplate: profile.nameplate && "preset" in profile.nameplate ? profile.nameplate.preset : undefined,
            hasNameplateImage: !!this.nameplateMxc,
            nameStyle: nameStyleFromRichProfile(profile) ?? { font: "default", effect: "none" },
            links: profile.links.map((link) => ({
                id: this.newId(),
                label: link.label,
                url: link.url,
                invalid: false,
            })),
            boardTitle: profile.boardTitle ?? "",
            board: [],
            tagSpaceId: profile.tagSpaceId,
        };
        this.publish(draft, { error: undefined });
    }

    private newId(): string {
        return `item-${this.nextId++}`;
    }

    private revokePreviews(): void {
        const images = [
            this.pendingAvatar,
            this.pendingBanner,
            this.pendingNameplate,
            ...this.board.map((i) => i.pending),
        ];
        for (const image of images) {
            if (image) URL.revokeObjectURL(image.previewUrl);
        }
        this.pendingAvatar = this.pendingBanner = this.pendingNameplate = undefined;
    }

    /** The profile the draft describes, with the media chosen so far. */
    private draftProfile(draft: DesktopProfileEditorDraft): RichProfile {
        const nameStyle = draft.nameStyle;
        const bannerMxc = this.bannerMxc;
        let nameplate: RichNameplate | undefined;
        if (draft.hasNameplateImage && this.nameplateMxc) nameplate = { mxc: this.nameplateMxc };
        else if (draft.nameplate) nameplate = { preset: draft.nameplate };
        const board: RichBoardItem[] = this.board.map((item) => ({
            title: item.title.trim(),
            caption: item.caption.trim() || undefined,
            mxc: item.mxc,
        }));
        return {
            ...this.baseline,
            bannerMxc,
            bannerAnimated: bannerMxc ? this.bannerAnimated : undefined,
            animatedAvatarMxc:
                this.avatarMxc && this.avatarMxc === this.baseline.animatedAvatarMxc ? this.avatarMxc : undefined,
            bio: draft.bio.trim() || undefined,
            pronouns: draft.pronouns.trim() || undefined,
            theme: draft.theme,
            decoration: draft.decoration,
            effect: draft.effect,
            nameplate,
            nameFont: nameStyle.font,
            nameEffect: nameStyle.effect,
            nameColour: nameStyle.colour,
            nameColourEnd: nameStyle.colourEnd,
            links: draft.links.flatMap((link) => {
                const parsed = parseProfileUrl(link.url);
                return parsed ? [{ label: link.label.trim() || parsed.host, url: parsed.url }] : [];
            }),
            boardTitle: draft.boardTitle.trim() || undefined,
            board,
            tagSpaceId: draft.tagSpaceId,
        };
    }

    private isDirty(draft: DesktopProfileEditorDraft): boolean {
        if (this.pendingAvatar || this.pendingBanner || this.pendingNameplate) return true;
        if (this.board.some((item) => item.pending)) return true;
        if (draft.displayName.trim() !== this.baselineName.trim()) return true;
        if (this.avatarMxc !== this.baselineAvatarMxc) return true;
        if (draft.links.some((link) => link.invalid)) return true;
        if (this.statusChanged(draft)) return true;
        const comparable = (profile: RichProfile): string =>
            JSON.stringify({
                ...profile,
                status: undefined,
                timezone: undefined,
                nameFont: profile.nameFont === "default" ? undefined : profile.nameFont,
                nameEffect: profile.nameEffect === "none" ? undefined : profile.nameEffect,
                bannerAnimated: profile.bannerAnimated || undefined,
                board: profile.board.map((item) => ({ ...item, caption: item.caption || undefined })),
            });
        return comparable(this.draftProfile(draft)) !== comparable(this.baseline);
    }

    private statusChanged(draft: DesktopProfileEditorDraft): boolean {
        return (
            draft.statusText.trim() !== (this.baseline.status?.text ?? "") ||
            (!!draft.statusText.trim() && draft.statusEmoji !== (this.baseline.status?.emoji ?? ""))
        );
    }

    /** Recalculate everything that follows from the draft. */
    private publish(
        draft: DesktopProfileEditorDraft,
        extra: Partial<DesktopProfileEditorViewSnapshot> = { error: undefined, saved: false },
    ): void {
        const profile = this.draftProfile(draft);
        const editorBoard = this.board.map((item) => ({
            id: item.id,
            title: item.title,
            caption: item.caption,
            imageUrl:
                item.pending?.previewUrl ??
                (item.mxc
                    ? (mediaFromMxc(item.mxc).getThumbnailOfSourceHttp(96, 128, "crop") ?? undefined)
                    : undefined),
        }));
        const nextDraft: DesktopProfileEditorDraft = { ...draft, board: editorBoard };
        this.snapshot.merge({
            draft: nextDraft,
            preview: this.previewIdentity(nextDraft, profile),
            hasBanner: !!(this.bannerMxc || this.pendingBanner),
            hasAvatar: !!(this.avatarMxc || this.pendingAvatar),
            dirty: this.isDirty(nextDraft),
            tooLarge: richFieldBytes(profile) > MAX_RICH_FIELD_BYTES,
            ...extra,
        });
    }

    private previewIdentity(draft: DesktopProfileEditorDraft, profile: RichProfile): DesktopProfileIdentitySnapshot {
        const { client } = this.props;
        const appearance: DesktopProfileAppearance = {
            bannerUrl:
                this.pendingBanner?.previewUrl ??
                (this.bannerMxc
                    ? (mediaFromMxc(this.bannerMxc).getThumbnailOfSourceHttp(960, 384, "scale") ?? undefined)
                    : undefined),
            theme: draft.theme,
            decoration: draft.decoration,
            effect: draft.effect,
            nameplate: draft.hasNameplateImage
                ? {
                      imageUrl:
                          this.pendingNameplate?.previewUrl ??
                          (this.nameplateMxc
                              ? (mediaFromMxc(this.nameplateMxc).getThumbnailOfSourceHttp(480, 96, "scale") ?? "")
                              : ""),
                  }
                : draft.nameplate
                  ? { preset: draft.nameplate }
                  : undefined,
            nameStyle: draft.nameStyle,
        };
        const statusText = draft.statusText.trim();
        const tag = this.snapshot.current.tagOptions.find((option) => option.spaceId === draft.tagSpaceId);
        return {
            userId: client.getSafeUserId(),
            displayName: draft.displayName.trim() || client.getSafeUserId(),
            avatarUrl:
                this.pendingAvatar?.previewUrl ??
                (this.avatarMxc
                    ? (mediaFromMxc(this.avatarMxc).getThumbnailOfSourceHttp(160, 160, "crop") ?? undefined)
                    : undefined),
            presence: "online",
            roles: [],
            status: statusText ? { emoji: draft.statusEmoji || "💬", text: statusText } : undefined,
            appearance,
            pronouns: profile.pronouns,
            bio: profile.bio,
            tag: tag && { label: tag.label, emoji: tag.emoji, colour: tag.colour, spaceName: tag.spaceName },
        };
    }

    public update = (patch: Partial<DesktopProfileEditorDraft>): void => {
        this.publish({ ...this.snapshot.current.draft, ...patch });
    };

    /** Accept an image, or say why not. */
    private takeImage(file: File): PendingImage | undefined {
        if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
            this.snapshot.merge({ error: _t("desktop|profile_editor|error_image_type") });
            return undefined;
        }
        if (file.size > MAX_IMAGE_BYTES) {
            this.snapshot.merge({ error: _t("desktop|profile_editor|error_image_size") });
            return undefined;
        }
        return { file, previewUrl: URL.createObjectURL(file) };
    }

    public chooseAvatar = (file: File): void => {
        const image = this.takeImage(file);
        if (!image) return;
        if (this.pendingAvatar) URL.revokeObjectURL(this.pendingAvatar.previewUrl);
        this.pendingAvatar = image;
        this.publish(this.snapshot.current.draft);
    };

    public removeAvatar = (): void => {
        if (this.pendingAvatar) URL.revokeObjectURL(this.pendingAvatar.previewUrl);
        this.pendingAvatar = undefined;
        this.avatarMxc = undefined;
        this.publish(this.snapshot.current.draft);
    };

    public chooseBanner = (file: File): void => {
        const image = this.takeImage(file);
        if (!image) return;
        if (this.pendingBanner) URL.revokeObjectURL(this.pendingBanner.previewUrl);
        this.pendingBanner = image;
        this.publish(this.snapshot.current.draft);
    };

    public removeBanner = (): void => {
        if (this.pendingBanner) URL.revokeObjectURL(this.pendingBanner.previewUrl);
        this.pendingBanner = undefined;
        this.bannerMxc = undefined;
        this.bannerAnimated = undefined;
        this.publish(this.snapshot.current.draft);
    };

    public chooseNameplateImage = (file: File): void => {
        const image = this.takeImage(file);
        if (!image) return;
        if (this.pendingNameplate) URL.revokeObjectURL(this.pendingNameplate.previewUrl);
        this.pendingNameplate = image;
        this.publish({ ...this.snapshot.current.draft, nameplate: undefined, hasNameplateImage: true });
    };

    public surpriseName = (): void => {
        const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
        const colour = (): string => `hsl(${Math.floor(Math.random() * 360)} 90% 70%)`;
        this.update({
            nameStyle: {
                font: pick(PROFILE_NAME_FONTS),
                effect: pick(PROFILE_NAME_EFFECTS.filter((effect) => effect !== "none")),
                colour: hslToHex(colour()),
                colourEnd: hslToHex(colour()),
            },
        });
    };

    public addLink = (): void => {
        const { draft } = this.snapshot.current;
        if (draft.links.length >= MAX_LINKS) return;
        this.update({ links: [...draft.links, { id: this.newId(), label: "", url: "", invalid: false }] });
    };

    public updateLink = (id: string, patch: { label?: string; url?: string }): void => {
        const { draft } = this.snapshot.current;
        this.update({
            links: draft.links.map((link) => {
                if (link.id !== id) return link;
                const next = { ...link, ...patch };
                return { ...next, invalid: !!next.url.trim() && !parseProfileUrl(next.url) };
            }),
        });
    };

    public removeLink = (id: string): void => {
        const { draft } = this.snapshot.current;
        this.update({ links: draft.links.filter((link) => link.id !== id) });
    };

    public addBoardItem = (file: File): void => {
        if (this.board.length >= MAX_BOARD_ITEMS) return;
        const image = this.takeImage(file);
        if (!image) return;
        const title = file.name.replace(/\.[^.]+$/, "").slice(0, 60);
        this.board = [...this.board, { id: this.newId(), title, caption: "", pending: image }];
        this.publish(this.snapshot.current.draft);
    };

    public updateBoardItem = (id: string, patch: { title?: string; caption?: string }): void => {
        this.board = this.board.map((item) => (item.id === id ? { ...item, ...patch } : item));
        this.publish(this.snapshot.current.draft);
    };

    public removeBoardItem = (id: string): void => {
        const removed = this.board.find((item) => item.id === id);
        if (removed?.pending) URL.revokeObjectURL(removed.pending.previewUrl);
        this.board = this.board.filter((item) => item.id !== id);
        this.publish(this.snapshot.current.draft);
    };

    public reset = (): void => {
        this.adoptBaseline();
    };

    /** Upload everything still only on this computer. What finishes stays uploaded, so a retry skips it. */
    private async uploadPending(): Promise<void> {
        const { client } = this.props;
        if (this.pendingBanner) {
            const { content_uri: uri } = await client.uploadContent(this.pendingBanner.file);
            this.bannerAnimated = ANIMATED_TYPES.has(this.pendingBanner.file.type) || undefined;
            this.bannerMxc = uri;
            URL.revokeObjectURL(this.pendingBanner.previewUrl);
            this.pendingBanner = undefined;
        }
        if (this.pendingNameplate) {
            const { content_uri: uri } = await client.uploadContent(this.pendingNameplate.file);
            this.nameplateMxc = uri;
            URL.revokeObjectURL(this.pendingNameplate.previewUrl);
            this.pendingNameplate = undefined;
        }
        for (const item of this.board) {
            if (!item.pending) continue;
            const { content_uri: uri } = await client.uploadContent(item.pending.file);
            item.mxc = uri;
            URL.revokeObjectURL(item.pending.previewUrl);
            item.pending = undefined;
        }
    }

    /** Run a request, waiting out one short rate limit rather than failing a save the person just asked for. */
    private async withRateLimit<T>(request: () => Promise<T>): Promise<T> {
        try {
            return await request();
        } catch (error) {
            const wait =
                error instanceof MatrixError && error.errcode === "M_LIMIT_EXCEEDED" ? error.getRetryAfterMs() : null;
            if (wait === null || wait > MAX_RETRY_WAIT_MS) throw error;
            await new Promise((resolve) => setTimeout(resolve, wait));
            return request();
        }
    }

    private async saveAvatar(animatedAvatar: { mxc?: string }): Promise<void> {
        const { client } = this.props;
        if (this.pendingAvatar) {
            const { file, previewUrl } = this.pendingAvatar;
            const { content_uri: uri } = await client.uploadContent(file);
            await this.withRateLimit(() => client.setAvatarUrl(uri));
            this.avatarMxc = uri;
            this.baselineAvatarMxc = uri;
            this.raw = { ...this.raw, avatar_url: uri };
            if (ANIMATED_TYPES.has(file.type)) animatedAvatar.mxc = uri;
            URL.revokeObjectURL(previewUrl);
            this.pendingAvatar = undefined;
        } else if (this.avatarMxc !== this.baselineAvatarMxc) {
            // An empty string, because Synapse answers an unset value with an error.
            await this.withRateLimit(() => client.setAvatarUrl(""));
            this.baselineAvatarMxc = undefined;
            const { avatar_url: _removed, ...rest } = this.raw;
            this.raw = rest;
        }
    }

    public save = async (): Promise<void> => {
        const { client } = this.props;
        const { draft, saving, tooLarge } = this.snapshot.current;
        if (saving || tooLarge) return;
        if (draft.links.some((link) => link.invalid)) {
            this.snapshot.merge({ error: _t("desktop|profile_editor|error_link") });
            return;
        }
        this.snapshot.merge({ saving: true, error: undefined, saved: false });
        const userId = client.getSafeUserId();
        try {
            await this.uploadPending();
            const animatedAvatar: { mxc?: string } = { mxc: this.baseline.animatedAvatarMxc };
            await this.saveAvatar(animatedAvatar);
            const displayName = draft.displayName.trim();
            if (displayName !== this.baselineName.trim() && displayName) {
                await this.withRateLimit(() => client.setDisplayName(displayName));
                this.baselineName = displayName;
                this.raw = { ...this.raw, displayname: displayName };
            }

            const next = { ...this.draftProfile(draft), animatedAvatarMxc: animatedAvatar.mxc };
            const writes = buildProfileWrites(this.raw, this.baseline, next, getCurrentLanguage());
            for (const { key, value } of writes) {
                if (!this.canWrite(key)) continue;
                if (value === null) {
                    await this.withRateLimit(() => client.deleteExtendedProfileProperty(key));
                    const { [key]: _removed, ...rest } = this.raw;
                    this.raw = rest;
                } else {
                    await this.withRateLimit(() => client.setExtendedProfileProperty(key, value));
                    this.raw = { ...this.raw, [key]: value };
                }
            }

            if (this.statusChanged(draft)) {
                const text = draft.statusText.trim();
                if (text) {
                    const status = { emoji: draft.statusEmoji || "💬", text };
                    await this.withRateLimit(() => setUserStatus(client, status));
                    this.raw = { ...this.raw, "org.matrix.msc4426.status": status };
                } else {
                    await this.withRateLimit(() => clearAllUserStatus(client));
                    const { "org.matrix.msc4426.status": _removed, ...rest } = this.raw;
                    this.raw = rest;
                }
            }

            this.baseline = parseRichProfile(this.raw);
            this.store.set(userId, this.raw);
            // People looking at this profile may not otherwise notice for minutes; this is only a courtesy.
            void this.store
                .announceUpdate()
                .catch((error) => logger.warn("Could not announce the profile update", error));
            if (this.isDisposed) return;
            this.adoptBaseline();
            this.snapshot.merge({ saving: false, saved: true, error: undefined });
        } catch (error) {
            logger.warn("Could not save the profile", error);
            if (this.isDisposed) return;
            this.snapshot.merge({ saving: false, error: saveErrorMessage(error) });
        }
    };
}

function saveErrorMessage(error: unknown): string {
    if (error instanceof MatrixError) {
        if (error.errcode === "M_PROFILE_TOO_LARGE" || error.errcode === "M_TOO_LARGE") {
            return _t("desktop|profile_editor|error_too_large");
        }
        if (error.errcode === "M_LIMIT_EXCEEDED") return _t("desktop|profile_editor|error_rate_limit");
        if (error.errcode === "M_FORBIDDEN") return _t("desktop|profile_editor|error_forbidden");
    }
    return _t("desktop|profile_editor|error_generic");
}

/** The profile field only accepts `#rrggbb`. */
function hslToHex(hsl: string): string {
    const match = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(hsl);
    const [h, s, l] = match ? [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100] : [0, 0, 1];
    const channel = (n: number): string => {
        const k = (n + h / 30) % 12;
        const value = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(value * 255)
            .toString(16)
            .padStart(2, "0");
    };
    return `#${channel(0)}${channel(8)}${channel(4)}`;
}
