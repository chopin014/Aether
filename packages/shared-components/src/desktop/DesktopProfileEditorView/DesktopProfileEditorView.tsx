/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type ChangeEvent, type JSX, type ReactNode, useId, useRef, useState } from "react";
import { Avatar, Button, IconButton, Text } from "@vector-im/compound-web";
import DeleteIcon from "@vector-im/compound-design-tokens/assets/web/icons/delete";
import ImageIcon from "@vector-im/compound-design-tokens/assets/web/icons/image";
import PlusIcon from "@vector-im/compound-design-tokens/assets/web/icons/plus";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { _td } from "../../core/i18n/i18n";
import {
    DesktopProfileBanner,
    DesktopProfileBio,
    DesktopProfileNames,
    DesktopProfileRoles,
    DesktopProfileSurface,
    DesktopProfileTagChip,
    type DesktopProfileIdentitySnapshot,
    type DesktopProfileTag,
} from "../DesktopProfileIdentity";
import {
    PROFILE_DECORATIONS,
    PROFILE_EFFECTS,
    PROFILE_NAME_EFFECTS,
    PROFILE_NAME_FONTS,
    PROFILE_NAMEPLATES,
    ProfileDecoration,
    ProfileEffectLayer,
    ProfileName,
    ProfileNameplate,
    useProfileMotion,
    type ProfileDecorationId,
    type ProfileEffectId,
    type ProfileNameEffect,
    type ProfileNameFont,
    type ProfileNameplateId,
    type ProfileNameStyle,
    type ProfileTheme,
} from "../ProfileAppearance";
import styles from "./DesktopProfileEditorView.module.css";

const DECORATION_LABELS: Record<ProfileDecorationId, TranslationKey> = {
    "neon-ring": _td("desktop|profile_editor|decorations|neon_ring"),
    "flame-crown": _td("desktop|profile_editor|decorations|flame_crown"),
    "sakura-wreath": _td("desktop|profile_editor|decorations|sakura_wreath"),
    "frost-crown": _td("desktop|profile_editor|decorations|frost_crown"),
    "halo": _td("desktop|profile_editor|decorations|halo"),
    "orbit": _td("desktop|profile_editor|decorations|orbit"),
    "thorn-rose": _td("desktop|profile_editor|decorations|thorn_rose"),
    "cat-ears": _td("desktop|profile_editor|decorations|cat_ears"),
    "galaxy": _td("desktop|profile_editor|decorations|galaxy"),
    "glitch": _td("desktop|profile_editor|decorations|glitch"),
};
const EFFECT_LABELS: Record<ProfileEffectId, TranslationKey> = {
    snow: _td("desktop|profile_editor|effects|snow"),
    sakura: _td("desktop|profile_editor|effects|sakura"),
    stars: _td("desktop|profile_editor|effects|stars"),
    embers: _td("desktop|profile_editor|effects|embers"),
    fireflies: _td("desktop|profile_editor|effects|fireflies"),
    rain: _td("desktop|profile_editor|effects|rain"),
    aurora: _td("desktop|profile_editor|effects|aurora"),
    confetti: _td("desktop|profile_editor|effects|confetti"),
};
const NAMEPLATE_LABELS: Record<ProfileNameplateId, TranslationKey> = {
    moonlit: _td("desktop|profile_editor|nameplates|moonlit"),
    blossom: _td("desktop|profile_editor|nameplates|blossom"),
    roses: _td("desktop|profile_editor|nameplates|roses"),
    nebula: _td("desktop|profile_editor|nameplates|nebula"),
    aurora: _td("desktop|profile_editor|nameplates|aurora"),
    embers: _td("desktop|profile_editor|nameplates|embers"),
    tides: _td("desktop|profile_editor|nameplates|tides"),
    circuit: _td("desktop|profile_editor|nameplates|circuit"),
};
const FONT_LABELS: Record<ProfileNameFont, TranslationKey> = {
    default: _td("desktop|profile_editor|fonts|default"),
    pixel: _td("desktop|profile_editor|fonts|pixel"),
    medieval: _td("desktop|profile_editor|fonts|medieval"),
    script: _td("desktop|profile_editor|fonts|script"),
    scifi: _td("desktop|profile_editor|fonts|scifi"),
    rounded: _td("desktop|profile_editor|fonts|rounded"),
    horror: _td("desktop|profile_editor|fonts|horror"),
};
const NAME_EFFECT_LABELS: Record<ProfileNameEffect, TranslationKey> = {
    none: _td("desktop|profile_editor|name_effects|none"),
    gradient: _td("desktop|profile_editor|name_effects|gradient"),
    shimmer: _td("desktop|profile_editor|name_effects|shimmer"),
    neon: _td("desktop|profile_editor|name_effects|neon"),
    outline: _td("desktop|profile_editor|name_effects|outline"),
};

/** Theme pairs to start from. */
const THEME_PRESETS: ProfileTheme[] = [
    { primary: "#14163a", accent: "#7b2fd0" },
    { primary: "#1b0a0a", accent: "#c8102e" },
    { primary: "#0b2a33", accent: "#1fbfa6" },
    { primary: "#3a1830", accent: "#ff7ab6" },
    { primary: "#b8d4ff", accent: "#e3c7ff" },
    { primary: "#ffd9a8", accent: "#ff8f70" },
];

/** A link being edited. */
export interface DesktopProfileEditorLink {
    id: string;
    label: string;
    url: string;
    /** The address is not a usable web address. */
    invalid: boolean;
}

/** A board tile being edited. */
export interface DesktopProfileEditorBoardItem {
    id: string;
    title: string;
    caption: string;
    imageUrl?: string;
}

/** What the editor's fields currently hold. Saved only when the person asks. */
export interface DesktopProfileEditorDraft {
    displayName: string;
    pronouns: string;
    bio: string;
    statusEmoji: string;
    statusText: string;
    theme?: ProfileTheme;
    decoration?: ProfileDecorationId;
    effect?: ProfileEffectId;
    nameplate?: ProfileNameplateId;
    /** The person's own image is the nameplate, shown in the preview. */
    hasNameplateImage: boolean;
    nameStyle: ProfileNameStyle;
    links: DesktopProfileEditorLink[];
    boardTitle: string;
    board: DesktopProfileEditorBoardItem[];
    /** The Space whose tag is worn. */
    tagSpaceId?: string;
}

/** A Space whose tag can be worn. */
export interface DesktopProfileEditorTagOption extends DesktopProfileTag {
    spaceId: string;
}

/** Everything the editor renders. */
export interface DesktopProfileEditorViewSnapshot {
    /** `unsupported`: the homeserver has no custom profile fields. `read_only`: it forbids changing them. */
    state: "loading" | "ready" | "unsupported" | "read_only";
    draft: DesktopProfileEditorDraft;
    /** The draft as other people would see it. */
    preview: DesktopProfileIdentitySnapshot;
    hasBanner: boolean;
    hasAvatar: boolean;
    canSetDisplayName: boolean;
    canSetAvatar: boolean;
    tagOptions: DesktopProfileEditorTagOption[];
    dirty: boolean;
    saving: boolean;
    /** Why the last save failed, ready to show. */
    error?: string;
    /** The most recent save went through. */
    saved: boolean;
    /** The draft is too large to store, so it cannot be saved. */
    tooLarge: boolean;
    maxLinks: number;
    maxBoardItems: number;
}

/** What the editor can ask for. */
export interface DesktopProfileEditorViewActions {
    update(this: void, patch: Partial<DesktopProfileEditorDraft>): void;
    chooseAvatar(this: void, file: File): void;
    removeAvatar(this: void): void;
    chooseBanner(this: void, file: File): void;
    removeBanner(this: void): void;
    chooseNameplateImage(this: void, file: File): void;
    /** Pick a random name style, like Discord's "Surprise me". */
    surpriseName(this: void): void;
    addLink(this: void): void;
    updateLink(this: void, id: string, patch: { label?: string; url?: string }): void;
    removeLink(this: void, id: string): void;
    addBoardItem(this: void, file: File): void;
    updateBoardItem(this: void, id: string, patch: { title?: string; caption?: string }): void;
    removeBoardItem(this: void, id: string): void;
    save(this: void): void;
    reset(this: void): void;
}

/** Contract for the profile editor. */
export type DesktopProfileEditorViewModel = ViewModel<
    DesktopProfileEditorViewSnapshot,
    DesktopProfileEditorViewActions
>;

interface FilePickerProps {
    label: string;
    icon?: boolean;
    disabled?: boolean;
    kind?: "primary" | "secondary" | "tertiary";
    onFile: (file: File) => void;
}

/** A button that asks for an image. */
function ImagePicker({ label, disabled, kind = "secondary", onFile }: FilePickerProps): JSX.Element {
    const input = useRef<HTMLInputElement>(null);
    const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
        const file = event.target.files?.[0];
        if (file) onFile(file);
        // Choosing the same file again must still fire a change.
        event.target.value = "";
    };
    return (
        <>
            <Button size="md" kind={kind} Icon={ImageIcon} disabled={disabled} onClick={() => input.current?.click()}>
                {label}
            </Button>
            <input
                ref={input}
                className={styles.fileInput}
                type="file"
                accept="image/*"
                tabIndex={-1}
                aria-label={label}
                onChange={onChange}
            />
        </>
    );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): JSX.Element {
    return (
        <section className={styles.section}>
            <div className={styles.sectionHeading}>
                <Text as="h3" size="md" weight="semibold">
                    {title}
                </Text>
                {hint && (
                    <Text as="p" size="sm" className={styles.hint}>
                        {hint}
                    </Text>
                )}
            </div>
            {children}
        </section>
    );
}

interface TextFieldProps {
    label: string;
    value: string;
    placeholder?: string;
    maxLength?: number;
    multiline?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    onChange: (value: string) => void;
}

function TextField({ label, value, multiline, invalid, onChange, ...rest }: TextFieldProps): JSX.Element {
    const id = useId();
    return (
        <div className={styles.field}>
            <div className={styles.fieldHeading}>
                <label htmlFor={id}>{label}</label>
                {rest.maxLength && multiline && (
                    <span className={styles.counter}>
                        {value.length}/{rest.maxLength}
                    </span>
                )}
            </div>
            {multiline ? (
                <textarea
                    id={id}
                    className={styles.input}
                    rows={4}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    {...rest}
                />
            ) : (
                <input
                    id={id}
                    className={styles.input}
                    value={value}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => onChange(event.target.value)}
                    {...rest}
                />
            )}
        </div>
    );
}

function ColourField({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
}): JSX.Element {
    const id = useId();
    return (
        <label className={styles.colour} htmlFor={id}>
            <input id={id} type="color" value={value} onChange={(event) => onChange(event.target.value)} />
            <span>{label}</span>
        </label>
    );
}

interface PickerOption<Id extends string> {
    id: Id | undefined;
    label: string;
    art: ReactNode;
}

/** One tile, moving while the pointer is on it so it shows what the option really does. */
function PickerTile<Id extends string>({
    name,
    option,
    selected,
    onSelect,
}: {
    name: string;
    option: PickerOption<Id>;
    selected: boolean;
    onSelect: (id: Id | undefined) => void;
}): JSX.Element {
    const motion = useProfileMotion(false);
    return (
        <label className={styles.tile} data-selected={selected} {...motion.bind}>
            <input
                className={styles.tileRadio}
                type="radio"
                name={name}
                checked={selected}
                onChange={() => onSelect(option.id)}
            />
            <span className={styles.tileArt} aria-hidden="true">
                {option.art}
            </span>
            <span className={styles.tileLabel}>{option.label}</span>
        </label>
    );
}

function Picker<Id extends string>({
    label,
    options,
    value,
    onSelect,
}: {
    label: string;
    options: PickerOption<Id>[];
    value: Id | undefined;
    onSelect: (id: Id | undefined) => void;
}): JSX.Element {
    const name = useId();
    return (
        <div role="radiogroup" aria-label={label} className={styles.tiles}>
            {options.map((option) => (
                <PickerTile
                    key={option.id ?? "none"}
                    name={name}
                    option={option}
                    selected={value === option.id}
                    onSelect={onSelect}
                />
            ))}
        </div>
    );
}

/** The same row a member list draws, so a nameplate is judged where it will really be seen. */
function MemberRowPreview({ identity }: { identity: DesktopProfileIdentitySnapshot }): JSX.Element {
    const motion = useProfileMotion(false);
    const { appearance } = identity;
    return (
        <div className={styles.memberRow} {...motion.bind}>
            {appearance?.nameplate && <ProfileNameplate nameplate={appearance.nameplate} />}
            <span className={styles.memberAvatar}>
                <Avatar
                    id={identity.userId}
                    name={identity.displayName}
                    src={identity.avatarUrl}
                    size="32px"
                    type="round"
                />
                {appearance?.decoration && <ProfileDecoration id={appearance.decoration} />}
            </span>
            <span className={styles.memberText}>
                <span className={styles.memberName}>
                    <ProfileName nameStyle={appearance?.nameStyle}>{identity.displayName}</ProfileName>
                    {identity.tag && <DesktopProfileTagChip tag={identity.tag} />}
                </span>
                {identity.status && (
                    <span className={styles.memberStatus}>
                        {identity.status.emoji} {identity.status.text}
                    </span>
                )}
            </span>
        </div>
    );
}

/** Properties for the profile editor. */
interface DesktopProfileEditorViewProps {
    vm: DesktopProfileEditorViewModel;
}

/**
 * Edit how you appear to others, with a live preview of the real card and member row beside the fields. Nothing is
 * stored until the person presses Save, so experimenting is free.
 */
export function DesktopProfileEditorView({ vm }: DesktopProfileEditorViewProps): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const { draft, preview, state, dirty, saving } = snapshot;
    // Replaying the card restarts its opening animation so a choice can be seen again.
    const [replay, setReplay] = useState(0);

    if (state === "loading") {
        return (
            <Text as="p" role="status" className={styles.notice}>
                {_t("desktop|profile_editor|loading")}
            </Text>
        );
    }

    if (state === "unsupported") {
        return (
            <Text as="p" role="alert" className={styles.notice}>
                {_t("desktop|profile_editor|unsupported")}
            </Text>
        );
    }

    if (state === "read_only") {
        return (
            <Text as="p" role="alert" className={styles.notice}>
                {_t("desktop|profile_editor|read_only")}
            </Text>
        );
    }

    const update = vm.update;
    const nameStyle = draft.nameStyle;
    const setNameStyle = (patch: Partial<ProfileNameStyle>): void => update({ nameStyle: { ...nameStyle, ...patch } });
    const theme = draft.theme;

    return (
        <div className={styles.editor}>
            <div className={styles.columns}>
                <div className={styles.form}>
                    <Text as="p" size="sm" className={styles.privacy}>
                        {_t("desktop|profile_editor|privacy")}
                    </Text>

                    <Section title={_t("desktop|profile_editor|about")}>
                        <div className={styles.row}>
                            <ImagePicker
                                label={_t("desktop|profile_editor|change_avatar")}
                                disabled={!snapshot.canSetAvatar}
                                onFile={vm.chooseAvatar}
                            />
                            {snapshot.hasAvatar && (
                                <Button
                                    size="md"
                                    kind="tertiary"
                                    disabled={!snapshot.canSetAvatar}
                                    onClick={vm.removeAvatar}
                                >
                                    {_t("desktop|profile_editor|remove_avatar")}
                                </Button>
                            )}
                        </div>
                        <TextField
                            label={_t("desktop|profile_editor|display_name")}
                            value={draft.displayName}
                            maxLength={256}
                            disabled={!snapshot.canSetDisplayName}
                            onChange={(displayName) => update({ displayName })}
                        />
                        <TextField
                            label={_t("desktop|profile_editor|pronouns")}
                            value={draft.pronouns}
                            maxLength={40}
                            placeholder={_t("desktop|profile_editor|pronouns_placeholder")}
                            onChange={(pronouns) => update({ pronouns })}
                        />
                        <div className={styles.statusRow}>
                            <TextField
                                label={_t("desktop|profile_editor|status_emoji")}
                                value={draft.statusEmoji}
                                maxLength={16}
                                onChange={(statusEmoji) => update({ statusEmoji })}
                            />
                            <TextField
                                label={_t("desktop|profile_editor|status")}
                                value={draft.statusText}
                                maxLength={64}
                                placeholder={_t("desktop|profile_editor|status_placeholder")}
                                onChange={(statusText) => update({ statusText })}
                            />
                        </div>
                        <TextField
                            label={_t("desktop|profile_editor|bio")}
                            value={draft.bio}
                            maxLength={500}
                            multiline
                            placeholder={_t("desktop|profile_editor|bio_placeholder")}
                            onChange={(bio) => update({ bio })}
                        />
                    </Section>

                    <Section
                        title={_t("desktop|profile_editor|banner_theme")}
                        hint={_t("desktop|profile_editor|banner_hint")}
                    >
                        <div className={styles.row}>
                            <ImagePicker label={_t("desktop|profile_editor|change_banner")} onFile={vm.chooseBanner} />
                            {snapshot.hasBanner && (
                                <Button size="md" kind="tertiary" onClick={vm.removeBanner}>
                                    {_t("desktop|profile_editor|remove_banner")}
                                </Button>
                            )}
                        </div>
                        <div className={styles.swatches} role="group" aria-label={_t("desktop|profile_editor|theme")}>
                            <button
                                type="button"
                                className={styles.swatch}
                                data-selected={!theme}
                                aria-pressed={!theme}
                                aria-label={_t("desktop|profile_editor|theme_none")}
                                title={_t("desktop|profile_editor|theme_none")}
                                onClick={() => update({ theme: undefined })}
                            />
                            {THEME_PRESETS.map((preset) => {
                                const selected = theme?.primary === preset.primary && theme?.accent === preset.accent;
                                return (
                                    <button
                                        key={preset.primary}
                                        type="button"
                                        className={styles.swatch}
                                        data-selected={selected}
                                        aria-pressed={selected}
                                        aria-label={`${preset.primary} ${preset.accent}`}
                                        style={{
                                            background: `linear-gradient(180deg, ${preset.primary}, ${preset.accent})`,
                                        }}
                                        onClick={() => update({ theme: preset })}
                                    />
                                );
                            })}
                        </div>
                        <div className={styles.row}>
                            <ColourField
                                label={_t("desktop|profile_editor|theme_primary")}
                                value={theme?.primary ?? "#1c1d29"}
                                onChange={(primary) =>
                                    update({ theme: { primary, accent: theme?.accent ?? "#35375a" } })
                                }
                            />
                            <ColourField
                                label={_t("desktop|profile_editor|theme_accent")}
                                value={theme?.accent ?? "#35375a"}
                                onChange={(accent) =>
                                    update({ theme: { primary: theme?.primary ?? "#1c1d29", accent } })
                                }
                            />
                        </div>
                    </Section>

                    <Section title={_t("desktop|profile_editor|decoration")}>
                        <Picker
                            label={_t("desktop|profile_editor|decoration")}
                            value={draft.decoration}
                            onSelect={(decoration) => update({ decoration })}
                            options={[
                                { id: undefined, label: _t("desktop|profile_editor|none"), art: null },
                                ...PROFILE_DECORATIONS.map((id) => ({
                                    id,
                                    label: _t(DECORATION_LABELS[id]),
                                    art: (
                                        <span className={styles.decorationArt}>
                                            <Avatar
                                                id={preview.userId}
                                                name={preview.displayName}
                                                src={preview.avatarUrl}
                                                size="44px"
                                                type="round"
                                            />
                                            <ProfileDecoration id={id} />
                                        </span>
                                    ),
                                })),
                            ]}
                        />
                    </Section>

                    <Section title={_t("desktop|profile_editor|effect")}>
                        <Picker
                            label={_t("desktop|profile_editor|effect")}
                            value={draft.effect}
                            onSelect={(effect) => {
                                update({ effect });
                                setReplay((value) => value + 1);
                            }}
                            options={[
                                { id: undefined, label: _t("desktop|profile_editor|none"), art: null },
                                ...PROFILE_EFFECTS.map((id) => ({
                                    id,
                                    label: _t(EFFECT_LABELS[id]),
                                    art: (
                                        <span className={styles.effectArt}>
                                            <ProfileEffectLayer id={id} seed="preview" />
                                        </span>
                                    ),
                                })),
                            ]}
                        />
                    </Section>

                    <Section
                        title={_t("desktop|profile_editor|nameplate")}
                        hint={_t("desktop|profile_editor|nameplate_hint")}
                    >
                        <Picker
                            label={_t("desktop|profile_editor|nameplate")}
                            value={draft.hasNameplateImage ? undefined : draft.nameplate}
                            onSelect={(nameplate) => update({ nameplate, hasNameplateImage: false })}
                            options={[
                                { id: undefined, label: _t("desktop|profile_editor|none"), art: null },
                                ...PROFILE_NAMEPLATES.map((id) => ({
                                    id,
                                    label: _t(NAMEPLATE_LABELS[id]),
                                    art: (
                                        <span className={styles.nameplateArt}>
                                            <ProfileNameplate nameplate={{ preset: id }} />
                                        </span>
                                    ),
                                })),
                            ]}
                        />
                        <div className={styles.row}>
                            <ImagePicker
                                label={_t("desktop|profile_editor|nameplate_image")}
                                onFile={vm.chooseNameplateImage}
                            />
                        </div>
                    </Section>

                    <Section title={_t("desktop|profile_editor|name_style")}>
                        <Picker
                            label={_t("desktop|profile_editor|name_font")}
                            value={nameStyle.font}
                            onSelect={(font) => setNameStyle({ font: font ?? "default" })}
                            options={PROFILE_NAME_FONTS.map((id) => ({
                                id,
                                label: _t(FONT_LABELS[id]),
                                art: (
                                    <ProfileName nameStyle={{ font: id, effect: "none" }}>
                                        {preview.displayName}
                                    </ProfileName>
                                ),
                            }))}
                        />
                        <div className={styles.row} role="group" aria-label={_t("desktop|profile_editor|name_effect")}>
                            {PROFILE_NAME_EFFECTS.map((id) => (
                                <Button
                                    key={id}
                                    size="md"
                                    kind={nameStyle.effect === id ? "primary" : "secondary"}
                                    aria-pressed={nameStyle.effect === id}
                                    onClick={() => setNameStyle({ effect: id })}
                                >
                                    {_t(NAME_EFFECT_LABELS[id])}
                                </Button>
                            ))}
                        </div>
                        <div className={styles.row}>
                            <ColourField
                                label={_t("desktop|profile_editor|name_colour")}
                                value={nameStyle.colour ?? "#ffffff"}
                                onChange={(colour) => setNameStyle({ colour })}
                            />
                            <ColourField
                                label={_t("desktop|profile_editor|name_colour_end")}
                                value={nameStyle.colourEnd ?? nameStyle.colour ?? "#ffffff"}
                                onChange={(colourEnd) => setNameStyle({ colourEnd })}
                            />
                            <Button size="md" kind="tertiary" onClick={vm.surpriseName}>
                                {_t("desktop|profile_editor|surprise")}
                            </Button>
                            <Button
                                size="md"
                                kind="tertiary"
                                onClick={() => update({ nameStyle: { font: "default", effect: "none" } })}
                            >
                                {_t("desktop|profile_editor|name_clear")}
                            </Button>
                        </div>
                    </Section>

                    {snapshot.tagOptions.length > 0 && (
                        <Section title={_t("desktop|profile_editor|tag")} hint={_t("desktop|profile_editor|tag_hint")}>
                            <div className={styles.row} role="group" aria-label={_t("desktop|profile_editor|tag")}>
                                <Button
                                    size="md"
                                    kind={draft.tagSpaceId ? "secondary" : "primary"}
                                    aria-pressed={!draft.tagSpaceId}
                                    onClick={() => update({ tagSpaceId: undefined })}
                                >
                                    {_t("desktop|profile_editor|none")}
                                </Button>
                                {snapshot.tagOptions.map((option) => (
                                    <Button
                                        key={option.spaceId}
                                        size="md"
                                        kind={draft.tagSpaceId === option.spaceId ? "primary" : "secondary"}
                                        aria-pressed={draft.tagSpaceId === option.spaceId}
                                        onClick={() => update({ tagSpaceId: option.spaceId })}
                                    >
                                        {option.emoji} {option.label} · {option.spaceName}
                                    </Button>
                                ))}
                            </div>
                        </Section>
                    )}

                    <Section title={_t("desktop|profile_editor|links")} hint={_t("desktop|profile_editor|links_hint")}>
                        {draft.links.map((link) => (
                            <div key={link.id} className={styles.linkRow}>
                                <TextField
                                    label={_t("desktop|profile_editor|link_label")}
                                    value={link.label}
                                    maxLength={40}
                                    onChange={(label) => vm.updateLink(link.id, { label })}
                                />
                                <TextField
                                    label={_t("desktop|profile_editor|link_url")}
                                    value={link.url}
                                    maxLength={512}
                                    invalid={link.invalid}
                                    placeholder="https://"
                                    onChange={(url) => vm.updateLink(link.id, { url })}
                                />
                                <IconButton
                                    size="32px"
                                    tooltip={_t("desktop|profile_editor|remove_link")}
                                    onClick={() => vm.removeLink(link.id)}
                                >
                                    <DeleteIcon />
                                </IconButton>
                            </div>
                        ))}
                        {draft.links.length < snapshot.maxLinks && (
                            <div className={styles.row}>
                                <Button size="md" kind="secondary" Icon={PlusIcon} onClick={vm.addLink}>
                                    {_t("desktop|profile_editor|add_link")}
                                </Button>
                            </div>
                        )}
                    </Section>

                    <Section title={_t("desktop|profile_editor|board")} hint={_t("desktop|profile_editor|board_hint")}>
                        <TextField
                            label={_t("desktop|profile_editor|board_title")}
                            value={draft.boardTitle}
                            maxLength={40}
                            placeholder={_t("desktop|profile_editor|board_title_placeholder")}
                            onChange={(boardTitle) => update({ boardTitle })}
                        />
                        {draft.board.map((item) => (
                            <div key={item.id} className={styles.boardRow}>
                                {item.imageUrl && <img className={styles.boardThumb} src={item.imageUrl} alt="" />}
                                <TextField
                                    label={_t("desktop|profile_editor|board_item_title")}
                                    value={item.title}
                                    maxLength={60}
                                    onChange={(title) => vm.updateBoardItem(item.id, { title })}
                                />
                                <TextField
                                    label={_t("desktop|profile_editor|board_item_caption")}
                                    value={item.caption}
                                    maxLength={80}
                                    onChange={(caption) => vm.updateBoardItem(item.id, { caption })}
                                />
                                <IconButton
                                    size="32px"
                                    tooltip={_t("desktop|profile_editor|remove_board_item")}
                                    onClick={() => vm.removeBoardItem(item.id)}
                                >
                                    <DeleteIcon />
                                </IconButton>
                            </div>
                        ))}
                        {draft.board.length < snapshot.maxBoardItems && (
                            <div className={styles.row}>
                                <ImagePicker
                                    label={_t("desktop|profile_editor|add_board_item")}
                                    onFile={vm.addBoardItem}
                                />
                            </div>
                        )}
                    </Section>
                </div>

                <aside className={styles.preview} aria-label={_t("desktop|profile_editor|preview")}>
                    <Text as="h3" size="sm" weight="semibold" className={styles.previewHeading}>
                        {_t("desktop|profile_editor|preview")}
                    </Text>
                    <DesktopProfileSurface key={replay} identity={preview} className={styles.previewCard}>
                        <DesktopProfileBanner identity={preview} size="popout" />
                        <div className={styles.previewBody}>
                            <DesktopProfileNames identity={preview} />
                            {preview.bio && <DesktopProfileBio bio={preview.bio} />}
                            <DesktopProfileRoles roles={preview.roles} />
                        </div>
                    </DesktopProfileSurface>
                    <Text as="h3" size="sm" weight="semibold" className={styles.previewHeading}>
                        {_t("desktop|profile_editor|preview_member")}
                    </Text>
                    <MemberRowPreview identity={preview} />
                </aside>
            </div>

            {(dirty || snapshot.error || snapshot.saved || snapshot.tooLarge) && (
                <div className={styles.saveBar} data-state={snapshot.error || snapshot.tooLarge ? "error" : undefined}>
                    <Text as="p" size="sm" role={snapshot.error || snapshot.tooLarge ? "alert" : "status"}>
                        {snapshot.tooLarge
                            ? _t("desktop|profile_editor|too_large")
                            : (snapshot.error ??
                              (dirty ? _t("desktop|profile_editor|unsaved") : _t("desktop|profile_editor|saved")))}
                    </Text>
                    {dirty && (
                        <div className={styles.saveActions}>
                            <Button size="md" kind="tertiary" disabled={saving} onClick={vm.reset}>
                                {_t("desktop|profile_editor|reset")}
                            </Button>
                            <Button size="md" disabled={saving || snapshot.tooLarge} onClick={vm.save}>
                                {saving ? _t("desktop|profile_editor|saving") : _t("desktop|profile_editor|save")}
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
