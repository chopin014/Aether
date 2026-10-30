/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useId, useRef, useState } from "react";
import { Avatar, Text } from "@vector-im/compound-web";
import {
    SearchIcon,
    VolumeOnIcon,
    ChevronDownIcon,
    HistoryIcon,
    PlaySolidIcon,
    DeleteIcon,
    PlusIcon,
    EditIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { SoundboardClipView, type SoundboardClipSnapshot } from "./SoundboardClipView";
import { EmojiPicker } from "../../core/EmojiPicker";
import { SoundboardIcon } from "./SoundboardIcon";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./SoundboardView.module.css";

/** One sound in a shared library. */
export interface SoundboardSound {
    id: string;
    name: string;
    emoji: string;
    libraryId: string;
}
/** A Space or channel whose sounds are available in the call. */
export interface SoundboardLibrary {
    id: string;
    name: string;
    avatarUrl?: string;
    canUpload: boolean;
    sounds: readonly SoundboardSound[];
}
/** The searchable library and upload form state. */
export interface SoundboardViewSnapshot {
    selectedLibraryId?: string;
    query: string;
    libraries: readonly SoundboardLibrary[];
    suggested: readonly SoundboardSound[];
    volume: number;
    busy: boolean;
    error?: string;
    uploadLibraryId: string;
    uploadName: string;
    uploadEmoji: string;
    /** Local preview and selection; absent until an audio file is chosen. */
    clip?: SoundboardClipSnapshot;
}
/** Soundboard actions; preview is heard only on this device. */
export interface SoundboardViewActions {
    open(): void;
    setLibrary(id: string): void;
    setQuery(query: string): void;
    setVolume(volume: number): void;
    play(sound: SoundboardSound, preview?: boolean): Promise<void>;
    setUploadLibrary(id: string): void;
    setUploadName(name: string): void;
    setUploadEmoji(emoji: string): void;
    upload(file: File): Promise<void>;
    edit(sound: SoundboardSound): Promise<void>;
    setClipVolume(volume: number): void;
    setClipRange(start: number, end: number): void;
    previewClip(): Promise<void>;
    stopClipPreview(): void;
    cancelClip(): void;
    saveClip(): Promise<void>;
    remove(sound: SoundboardSound): Promise<void>;
}
/** Presentation contract for the call soundboard. */
export type SoundboardViewModel = ViewModel<SoundboardViewSnapshot, SoundboardViewActions>;

/** Searchable Space sound libraries. Props supply the soundboard view model. */
export function SoundboardView({ vm }: { vm: SoundboardViewModel }): JSX.Element {
    const {
        selectedLibraryId,
        query,
        libraries,
        suggested,
        volume,
        busy,
        error,
        uploadLibraryId,
        uploadName,
        uploadEmoji,
        clip,
    } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
    const emojiButton = useRef<HTMLButtonElement>(null);
    const emojiPicker = useRef<HTMLDivElement>(null);
    const emojiPickerId = useId();
    const closeEmojiPicker = (): void => {
        setEmojiPickerOpen(false);
        emojiButton.current?.focus();
    };
    useEffect(() => {
        if (!emojiPickerOpen) return;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            // Handle Escape before the containing call popover dismisses itself.
            event.preventDefault();
            event.stopPropagation();
            setEmojiPickerOpen(false);
            emojiButton.current?.focus();
        };
        const onOutside = (event: Event): void => {
            const target = event.target;
            if (
                target instanceof Node &&
                !emojiPicker.current?.contains(target) &&
                !emojiButton.current?.contains(target)
            )
                setEmojiPickerOpen(false);
        };
        window.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("pointerdown", onOutside);
        document.addEventListener("focusin", onOutside);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("pointerdown", onOutside);
            document.removeEventListener("focusin", onOutside);
        };
    }, [emojiPickerOpen]);
    const search = useRef<HTMLInputElement>(null);
    const catalog = useRef<HTMLDivElement>(null);
    const sections = useRef(new Map<string, HTMLDetailsElement>());
    const visibleLibraries = libraries.filter((library) => library.sounds.length > 0);
    useEffect(() => {
        vm.open();
        search.current?.focus();
        return () => vm.stopClipPreview();
    }, [vm]);
    useEffect(() => {
        const section = selectedLibraryId ? sections.current.get(selectedLibraryId) : undefined;
        if (section) section.open = true;
        if (catalog.current) catalog.current.scrollTop = section ? section.offsetTop - catalog.current.offsetTop : 0;
    }, [selectedLibraryId, query]);
    const libraryIcon = (library: SoundboardLibrary, size: "20px" | "40px"): JSX.Element =>
        library.id === "builtin" ? (
            <SoundboardIcon aria-hidden="true" />
        ) : (
            <Avatar id={library.id} name={library.name} src={library.avatarUrl} size={size} aria-hidden="true" />
        );
    const tiles = (sounds: readonly SoundboardSound[], canRemove = false): JSX.Element => (
        <div className={styles.grid}>
            {sounds.map((sound) => (
                <div className={styles.tile} key={`${sound.libraryId}/${sound.id}`}>
                    <button type="button" disabled={busy} className={styles.play} onClick={() => void vm.play(sound)}>
                        <span className={styles.emoji} aria-hidden="true">
                            {sound.emoji}
                        </span>
                        <Text size="sm" weight="semibold">
                            {sound.name}
                        </Text>
                    </button>
                    <div className={styles.tileActions}>
                        <button
                            type="button"
                            aria-label={_t("desktop|soundboard|preview", { name: sound.name })}
                            onClick={() => void vm.play(sound, true)}
                        >
                            <PlaySolidIcon aria-hidden="true" />
                        </button>
                        {canRemove && (
                            <button
                                type="button"
                                disabled={busy}
                                aria-label={_t("desktop|soundboard|edit", { name: sound.name })}
                                onClick={() => void vm.edit(sound)}
                            >
                                <EditIcon aria-hidden="true" />
                            </button>
                        )}
                        {canRemove && (
                            <button
                                type="button"
                                disabled={busy}
                                aria-label={_t("desktop|soundboard|remove", { name: sound.name })}
                                onClick={() => void vm.remove(sound)}
                            >
                                <DeleteIcon aria-hidden="true" />
                            </button>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
    return (
        <div className={styles.root} data-soundboard data-editing={!!clip}>
            <div className={styles.searchHeader}>
                <label className={styles.searchField}>
                    <SearchIcon aria-hidden="true" />
                    <input
                        ref={search}
                        className={styles.searchInput}
                        type="search"
                        aria-label={_t("desktop|soundboard|search")}
                        placeholder={_t("desktop|soundboard|search")}
                        value={query}
                        onChange={(event) => vm.setQuery(event.target.value)}
                    />
                </label>
                <details className={styles.volumeMenu}>
                    <summary aria-label={_t("desktop|soundboard|volume")} title={_t("desktop|soundboard|volume")}>
                        <VolumeOnIcon aria-hidden="true" />
                    </summary>
                    <label className={styles.volume}>
                        <Text size="xs" weight="semibold">
                            {_t("desktop|soundboard|volume")}
                        </Text>
                        <input
                            aria-label={_t("desktop|soundboard|volume")}
                            type="range"
                            min={0}
                            max={100}
                            value={volume}
                            onChange={(event) => vm.setVolume(Number(event.target.value))}
                        />
                    </label>
                </details>
            </div>
            <div className={styles.browser}>
                <nav className={styles.libraryRail} aria-label={_t("desktop|soundboard|library")}>
                    <button
                        type="button"
                        title={_t("desktop|soundboard|frequently_used")}
                        aria-label={_t("desktop|soundboard|all_sounds")}
                        aria-pressed={!selectedLibraryId}
                        onClick={() => vm.setLibrary("")}
                    >
                        <HistoryIcon aria-hidden="true" />
                    </button>
                    {visibleLibraries.map((library) => (
                        <button
                            key={library.id}
                            type="button"
                            title={library.name}
                            aria-label={library.name}
                            aria-pressed={selectedLibraryId === library.id}
                            onClick={() => vm.setLibrary(library.id)}
                        >
                            {libraryIcon(library, "40px")}
                        </button>
                    ))}
                </nav>
                <div className={styles.catalog} ref={catalog}>
                    {!query && suggested.length > 0 && (
                        <details open>
                            <summary className={styles.libraryName}>
                                <HistoryIcon aria-hidden="true" />
                                <Text size="sm" weight="semibold">
                                    {_t("desktop|soundboard|frequently_used")}
                                </Text>
                                <ChevronDownIcon aria-hidden="true" />
                            </summary>
                            {tiles(suggested.slice(0, 3))}
                        </details>
                    )}
                    {visibleLibraries.map((library) => (
                        <details
                            key={library.id}
                            open
                            ref={(element) => {
                                if (element) sections.current.set(library.id, element);
                                else sections.current.delete(library.id);
                            }}
                        >
                            <summary className={styles.libraryName}>
                                {libraryIcon(library, "20px")}
                                <Text size="sm" weight="semibold">
                                    {library.name}
                                </Text>
                                <ChevronDownIcon aria-hidden="true" />
                            </summary>
                            {tiles(library.sounds, library.canUpload)}
                        </details>
                    ))}
                    {query && !libraries.some((library) => library.sounds.length) && (
                        <div className={styles.emptyLibrary}>
                            <SearchIcon aria-hidden="true" />
                            <Text size="sm">{_t("desktop|soundboard|no_results")}</Text>
                        </div>
                    )}
                </div>
            </div>
            {libraries.some((library) => library.canUpload) && (
                <details className={styles.uploadDisclosure} open={clip ? true : undefined}>
                    <summary>
                        <PlusIcon aria-hidden="true" />
                        <Text size="sm" weight="semibold">
                            {clip?.editing ? _t("desktop|soundboard|edit_title") : _t("desktop|soundboard|upload")}
                        </Text>
                    </summary>
                    <fieldset className={styles.upload} disabled={busy}>
                        <legend className={styles.visuallyHidden}>{_t("desktop|soundboard|upload")}</legend>
                        <Text size="xs">{_t("desktop|soundboard|upload_help")}</Text>
                        <select
                            className={styles.input}
                            aria-label={_t("desktop|soundboard|library")}
                            value={uploadLibraryId}
                            disabled={clip?.editing}
                            onChange={(event) => vm.setUploadLibrary(event.target.value)}
                        >
                            {libraries
                                .filter((library) => library.canUpload)
                                .map((library) => (
                                    <option key={library.id} value={library.id}>
                                        {library.name}
                                    </option>
                                ))}
                        </select>
                        <div className={styles.uploadFields}>
                            <button
                                ref={emojiButton}
                                type="button"
                                className={styles.emojiButton}
                                aria-label={_t("desktop|soundboard|emoji")}
                                aria-haspopup="dialog"
                                aria-expanded={emojiPickerOpen}
                                aria-controls={emojiPickerOpen ? emojiPickerId : undefined}
                                onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
                            >
                                {uploadEmoji}
                            </button>
                            {emojiPickerOpen && (
                                <div
                                    ref={emojiPicker}
                                    id={emojiPickerId}
                                    role="dialog"
                                    aria-label={_t("desktop|soundboard|emoji")}
                                    className={styles.emojiPicker}
                                >
                                    <EmojiPicker
                                        onChoose={(unicode) => {
                                            vm.setUploadEmoji(unicode);
                                            closeEmojiPicker();
                                            return true;
                                        }}
                                        onFinished={closeEmojiPicker}
                                        showQuickReactions={false}
                                    />
                                </div>
                            )}
                            <input
                                className={styles.input}
                                aria-label={_t("desktop|soundboard|name")}
                                placeholder={_t("desktop|soundboard|name")}
                                value={uploadName}
                                maxLength={32}
                                onChange={(event) => vm.setUploadName(event.target.value)}
                            />
                        </div>
                        {clip && (
                            <SoundboardClipView
                                clip={clip}
                                disabled={busy}
                                onRange={vm.setClipRange}
                                onPreview={() => void vm.previewClip()}
                                onVolume={vm.setClipVolume}
                                onCancel={vm.cancelClip}
                                onSave={() => void vm.saveClip()}
                            />
                        )}
                        <label className={styles.fileButton}>
                            <Text size="sm" weight="semibold">
                                {clip ? _t("desktop|soundboard|replace_audio") : _t("desktop|soundboard|choose_audio")}
                            </Text>
                            <input
                                className={styles.visuallyHidden}
                                type="file"
                                accept="audio/mpeg,audio/ogg,audio/wav,audio/x-wav,audio/mp4,audio/webm"
                                aria-label={_t("desktop|soundboard|upload")}
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    if (file) void vm.upload(file);
                                    event.target.value = "";
                                }}
                            />
                        </label>
                    </fieldset>
                </details>
            )}
            {error && (
                <Text size="sm" role="alert">
                    {error}
                </Text>
            )}
        </div>
    );
}
