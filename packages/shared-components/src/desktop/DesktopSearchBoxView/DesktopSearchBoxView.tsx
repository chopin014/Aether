/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useId, useRef } from "react";
import SearchIcon from "@vector-im/compound-design-tokens/assets/web/icons/search";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import UserIcon from "@vector-im/compound-design-tokens/assets/web/icons/user";
import RoomIcon from "@vector-im/compound-design-tokens/assets/web/icons/room";
import AttachmentIcon from "@vector-im/compound-design-tokens/assets/web/icons/attachment";
import MentionIcon from "@vector-im/compound-design-tokens/assets/web/icons/mention";
import FilterIcon from "@vector-im/compound-design-tokens/assets/web/icons/filter";
import CalendarIcon from "@vector-im/compound-design-tokens/assets/web/icons/calendar";
import PinIcon from "@vector-im/compound-design-tokens/assets/web/icons/pin";
import HistoryIcon from "@vector-im/compound-design-tokens/assets/web/icons/history";
import SettingsIcon from "@vector-im/compound-design-tokens/assets/web/icons/settings";
import LinkIcon from "@vector-im/compound-design-tokens/assets/web/icons/link";
import ImageIcon from "@vector-im/compound-design-tokens/assets/web/icons/image";
import VideoIcon from "@vector-im/compound-design-tokens/assets/web/icons/video-call";
import AudioIcon from "@vector-im/compound-design-tokens/assets/web/icons/audio";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopSearchBoxView.module.css";

/** Filters the box can offer. `more` opens the second page of filters. */
export type DesktopSearchFilterKey =
    | "from"
    | "in"
    | "has"
    | "mentions"
    | "more"
    | "before"
    | "after"
    | "during"
    | "pinned"
    | "bot";

/** Names of the fixed, translated labels of a value suggestion. */
export type DesktopSearchValueKey =
    | "has_link"
    | "has_file"
    | "has_image"
    | "has_video"
    | "has_sound"
    | "pinned_true"
    | "pinned_false"
    | "bot_true"
    | "bot_false"
    | "today"
    | "yesterday";

/** One entry of the popover list. */
export type DesktopSearchOption =
    | { id: string; kind: "filter"; filter: DesktopSearchFilterKey }
    | {
          id: string;
          kind: "choice";
          filter: DesktopSearchFilterKey;
          /** Shown as is, for names of people and channels. */
          title?: string;
          /** A translated label, for values that are the same for everyone. */
          titleKey?: DesktopSearchValueKey;
          subtitle?: string;
      }
    | { id: string; kind: "recent"; text: string; chips: DesktopSearchChip[] }
    | { id: string; kind: "hint"; filter: DesktopSearchFilterKey }
    | { id: string; kind: "empty" };

export type DesktopSearchSectionId =
    | "filters"
    | "recent"
    | "members"
    | "channels"
    | "has"
    | "dates"
    | "more"
    | "values";

export interface DesktopSearchSection {
    id: DesktopSearchSectionId;
    options: DesktopSearchOption[];
    /** Shows a "Clear" button in the heading. */
    clearable?: boolean;
}

/** An accepted filter shown inside the input. */
export interface DesktopSearchChip {
    id: string;
    filter: DesktopSearchFilterKey;
    value: string;
}

export interface DesktopSearchBoxSnapshot {
    /** Name of the space or channel being searched. */
    scopeName: string;
    text: string;
    chips: DesktopSearchChip[];
    open: boolean;
    sections: DesktopSearchSection[];
    /** The highlighted option, which is also the combobox's active descendant. */
    activeId: string | null;
    /** Changing this number moves keyboard focus into the input. */
    focusRequest: number;
}

export interface DesktopSearchBoxActions {
    setText: (text: string) => void;
    setOpen: (open: boolean) => void;
    removeChip: (id: string) => void;
    removeLastChip: () => void;
    activate: (id: string) => void;
    moveActive: (direction: "next" | "previous") => void;
    /** Enter: uses the highlighted option, or runs the search when nothing is highlighted. */
    submit: () => void;
    clear: () => void;
    /** Escape. */
    dismiss: () => void;
    clearSection: (id: DesktopSearchSectionId) => void;
}

export type DesktopSearchBoxModel = ViewModel<DesktopSearchBoxSnapshot, DesktopSearchBoxActions>;

function FilterOptionIcon({ filter }: { filter: DesktopSearchFilterKey }): JSX.Element {
    switch (filter) {
        case "from":
            return <UserIcon />;
        case "in":
            return <RoomIcon />;
        case "has":
            return <AttachmentIcon />;
        case "mentions":
            return <MentionIcon />;
        case "more":
            return <FilterIcon />;
        case "before":
        case "after":
        case "during":
            return <CalendarIcon />;
        case "pinned":
            return <PinIcon />;
        case "bot":
            return <SettingsIcon />;
    }
}

function ValueIcon({ option }: { option: Extract<DesktopSearchOption, { kind: "choice" }> }): JSX.Element {
    switch (option.titleKey) {
        case "has_link":
            return <LinkIcon />;
        case "has_image":
            return <ImageIcon />;
        case "has_video":
            return <VideoIcon />;
        case "has_sound":
            return <AudioIcon />;
        default:
            return <FilterOptionIcon filter={option.filter} />;
    }
}

/**
 * Discord-style search field with filter chips and a suggestions popover. It follows the ARIA combobox pattern: DOM
 * focus stays in the input and the highlighted option is exposed through `aria-activedescendant`.
 */
export function DesktopSearchBoxView({ vm }: { vm: DesktopSearchBoxModel }): JSX.Element {
    const { translate: _t } = useI18n();
    const { scopeName, text, chips, open, sections, activeId, focusRequest } = useViewModel(vm);
    const id = useId();
    const input = useRef<HTMLInputElement>(null);
    const root = useRef<HTMLDivElement>(null);
    const listId = `${id}-list`;
    const optionId = (optionKey: string): string => `${id}-${optionKey}`;
    const hasQuery = text !== "" || chips.length > 0;

    useEffect(() => {
        if (focusRequest > 0) input.current?.focus();
    }, [focusRequest]);

    const filterLabel = (filter: DesktopSearchFilterKey): string => _t(`desktop|search|filter|${filter}|title`);
    const sectionHeadingId = (sectionId: string): string => `${id}-heading-${sectionId}`;
    const hasOptions = sections.some((section) => section.options.length > 0);

    return (
        <div
            ref={root}
            className={styles.box}
            onBlur={(event) => {
                // Close only when focus leaves the whole box, not when it moves between chips and the input.
                if (!root.current?.contains(event.relatedTarget)) vm.setOpen(false);
            }}
        >
            <div
                className={styles.field}
                onMouseDown={(event) => event.target === event.currentTarget && event.preventDefault()}
            >
                <SearchIcon aria-hidden className={styles.icon} onClick={() => input.current?.focus()} />
                {chips.map((chip) => (
                    <span key={chip.id} className={styles.chip}>
                        <span className={styles.chipKey}>{chip.filter}:</span>
                        <span className={styles.chipValue}>{chip.value}</span>
                        <button
                            type="button"
                            className={styles.chipRemove}
                            aria-label={_t("desktop|search|box|remove_filter", {
                                filter: `${chip.filter}:${chip.value}`,
                            })}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                                vm.removeChip(chip.id);
                                input.current?.focus();
                            }}
                        >
                            <CloseIcon aria-hidden />
                        </button>
                    </span>
                ))}
                <input
                    ref={input}
                    className={styles.input}
                    type="text"
                    role="combobox"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={_t("desktop|search|box|label")}
                    aria-expanded={open}
                    aria-haspopup="listbox"
                    aria-controls={open ? listId : undefined}
                    aria-autocomplete="list"
                    aria-activedescendant={open && activeId ? optionId(activeId) : undefined}
                    placeholder={chips.length ? "" : _t("desktop|search|box|placeholder", { name: scopeName })}
                    value={text}
                    onFocus={() => vm.setOpen(true)}
                    onClick={() => vm.setOpen(true)}
                    onChange={(event) => vm.setText(event.target.value)}
                    onKeyDown={(event) => {
                        switch (event.key) {
                            case "ArrowDown":
                            case "ArrowUp":
                                event.preventDefault();
                                if (!open) vm.setOpen(true);
                                else vm.moveActive(event.key === "ArrowDown" ? "next" : "previous");
                                break;
                            case "Enter":
                                event.preventDefault();
                                vm.submit();
                                break;
                            case "Escape":
                                event.preventDefault();
                                event.stopPropagation();
                                vm.dismiss();
                                break;
                            case "Backspace":
                                if (
                                    chips.length &&
                                    event.currentTarget.selectionStart === 0 &&
                                    event.currentTarget.selectionEnd === 0
                                ) {
                                    event.preventDefault();
                                    vm.removeLastChip();
                                }
                                break;
                        }
                    }}
                />
                {hasQuery && (
                    <button
                        type="button"
                        className={styles.clear}
                        aria-label={_t("desktop|search|box|clear")}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                            vm.clear();
                            input.current?.focus();
                        }}
                    >
                        <CloseIcon aria-hidden />
                    </button>
                )}
            </div>
            {open && (
                <div className={styles.popover}>
                    <div
                        id={listId}
                        role="listbox"
                        tabIndex={-1}
                        aria-label={_t("desktop|search|box|filters_label")}
                        className={styles.list}
                        onMouseDown={(event) => event.preventDefault()}
                    >
                        {sections
                            .filter((section) => section.options.length > 0)
                            .map((section) => (
                                <div
                                    key={section.id}
                                    role="group"
                                    aria-labelledby={sectionHeadingId(section.id)}
                                    className={styles.section}
                                >
                                    <div className={styles.heading}>
                                        <span id={sectionHeadingId(section.id)}>
                                            {_t(`desktop|search|section|${section.id}`)}
                                        </span>
                                        {section.clearable && (
                                            <button
                                                type="button"
                                                className={styles.headingAction}
                                                onClick={() => vm.clearSection(section.id)}
                                            >
                                                {_t("desktop|search|clear_recent")}
                                            </button>
                                        )}
                                    </div>
                                    {section.options.map((option) => {
                                        const active = option.id === activeId;
                                        if (option.kind === "hint" || option.kind === "empty") {
                                            return (
                                                <div key={option.id} className={styles.hint} role="presentation">
                                                    {option.kind === "hint"
                                                        ? _t("desktop|search|date_hint")
                                                        : _t("desktop|search|no_matches")}
                                                </div>
                                            );
                                        }
                                        return (
                                            // Focus stays in the input; the options are driven by its keys.
                                            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
                                            <div
                                                key={option.id}
                                                id={optionId(option.id)}
                                                tabIndex={-1}
                                                role="option"
                                                aria-selected={active}
                                                data-active={active || undefined}
                                                className={styles.option}
                                                onClick={() => vm.activate(option.id)}
                                            >
                                                <span className={styles.optionIcon} aria-hidden>
                                                    {option.kind === "filter" && (
                                                        <FilterOptionIcon filter={option.filter} />
                                                    )}
                                                    {option.kind === "choice" && <ValueIcon option={option} />}
                                                    {option.kind === "recent" && <HistoryIcon />}
                                                </span>
                                                <span className={styles.optionText}>
                                                    {option.kind === "filter" && (
                                                        <>
                                                            <span className={styles.optionTitle}>
                                                                {filterLabel(option.filter)}
                                                            </span>
                                                            <span className={styles.optionHint}>
                                                                {_t(`desktop|search|filter|${option.filter}|hint`)}
                                                            </span>
                                                        </>
                                                    )}
                                                    {option.kind === "choice" && (
                                                        <>
                                                            <span className={styles.optionTitle}>
                                                                {option.title ??
                                                                    (option.titleKey
                                                                        ? _t(`desktop|search|value|${option.titleKey}`)
                                                                        : "")}
                                                            </span>
                                                            {option.subtitle && (
                                                                <span className={styles.optionHint}>
                                                                    {option.subtitle}
                                                                </span>
                                                            )}
                                                        </>
                                                    )}
                                                    {option.kind === "recent" && (
                                                        <span className={styles.optionTitle}>
                                                            {option.chips
                                                                .map((chip) => `${chip.filter}:${chip.value} `)
                                                                .join("")}
                                                            {option.text}
                                                        </span>
                                                    )}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        {!hasOptions && <div className={styles.hint}>{_t("desktop|search|no_matches")}</div>}
                    </div>
                </div>
            )}
        </div>
    );
}
