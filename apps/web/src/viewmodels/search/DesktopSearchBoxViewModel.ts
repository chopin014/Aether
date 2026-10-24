/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopSearchBoxActions,
    type DesktopSearchBoxSnapshot,
    type DesktopSearchFilterKey,
    type DesktopSearchOption,
    type DesktopSearchSection,
    type DesktopSearchSectionId,
    type DesktopSearchValueKey,
} from "@element-hq/web-shared-components";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ActionPayload } from "../../dispatcher/payloads";
import { type FocusMessageSearchPayload } from "../../dispatcher/payloads/FocusMessageSearchPayload";
import { DESKTOP_SEARCH_UPDATE, type DesktopMessageSearchStore } from "../../stores/DesktopMessageSearchStore";
import {
    filterId,
    HAS_VALUES,
    isEmptyQuery,
    parseIsoDate,
    parseQuery,
    pendingFilter,
    type FilterValueResolver,
    type SearchFilter,
    type SearchFilterKey,
    type SearchQuery,
} from "../../utils/desktopSearch/query";
import { resolveScope, type ScopeInput } from "../../utils/desktopSearch/scope";
import { addRecentSearch, clearRecentSearches, loadRecentSearches } from "../../utils/desktopSearch/recents";

/** Where the active space comes from. The host wires this to `SpaceStore`. */
export interface DesktopSearchScopeProvider {
    get(): Pick<ScopeInput, "space">;
    subscribe(listener: () => void): () => void;
}

interface Props {
    client: MatrixClient;
    /** The room being viewed. */
    room: Room;
    store: DesktopMessageSearchStore;
    scope: DesktopSearchScopeProvider;
    storage?: Storage;
}

const MAX_SUGGESTIONS = 8;
const MAX_RECENTS_SHOWN = 5;
const BASE_FILTERS: DesktopSearchFilterKey[] = ["from", "in", "has", "mentions", "more"];
const MORE_FILTERS: DesktopSearchFilterKey[] = ["before", "after", "during", "pinned", "bot"];
const SINGLE_VALUED: ReadonlySet<string> = new Set(["before", "after", "during", "pinned", "bot"]);

function isoDay(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The state behind the header search box: text, accepted filters, suggestions and recent searches. It starts
 * searches by writing them to the shared store; the results column runs them.
 */
export class DesktopSearchBoxViewModel
    extends BaseViewModel<DesktopSearchBoxSnapshot, Props>
    implements DesktopSearchBoxActions
{
    private chips: SearchFilter[] = [];
    private text = "";
    private moreOpen = false;
    private open = false;
    private focusRequest = 0;
    private activeId: string | null = null;
    private recents: SearchQuery[];
    private sections: DesktopSearchSection[] = [];

    public constructor(props: Props) {
        super(props, {
            scopeName: "",
            text: "",
            chips: [],
            open: false,
            sections: [],
            activeId: null,
            focusRequest: 0,
        });
        this.recents = loadRecentSearches(props.client.getSafeUserId(), props.storage);

        // A box created after the user changed rooms picks the running search back up.
        const active = props.store.active;
        if (active) {
            this.chips = [...active.query.filters];
            this.text = active.query.text;
        }

        const ref = defaultDispatcher.register(this.onAction);
        this.disposables.track(() => defaultDispatcher.unregister(ref));
        this.disposables.trackListener(props.store, DESKTOP_SEARCH_UPDATE, this.onStoreUpdate);
        this.disposables.track(props.scope.subscribe(this.refresh));
        this.refresh();
    }

    private get userId(): string {
        return this.props.client.getSafeUserId();
    }

    private scopeInput(): ScopeInput {
        return { currentRoomId: this.props.room.roomId, ...this.props.scope.get() };
    }

    private scopeName(): string {
        const { space } = this.scopeInput();
        return space?.roomIds.has(this.props.room.roomId) ? space.name : this.props.room.name;
    }

    // --- actions -----------------------------------------------------------------------------------------------

    public setText = (text: string): void => {
        this.text = text;
        this.activeId = null;
        this.open = true;
        this.refresh();
    };

    public setOpen = (open: boolean): void => {
        if (open === this.open) return;
        this.open = open;
        if (open) this.moreOpen = false;
        this.activeId = null;
        this.refresh();
    };

    public removeChip = (id: string): void => {
        this.chips = this.chips.filter((chip) => filterId(chip) !== id);
        this.afterChipsChanged();
    };

    public removeLastChip = (): void => {
        if (!this.chips.length) return;
        this.chips = this.chips.slice(0, -1);
        this.afterChipsChanged();
    };

    public clear = (): void => {
        this.chips = [];
        this.text = "";
        this.activeId = null;
        this.props.store.close();
        this.refresh();
    };

    public clearSection = (id: DesktopSearchSectionId): void => {
        if (id !== "recent") return;
        clearRecentSearches(this.userId, this.props.storage);
        this.recents = [];
        this.refresh();
    };

    public dismiss = (): void => {
        if (this.open) {
            this.open = false;
            this.moreOpen = false;
            this.activeId = null;
            this.refresh();
        } else if (this.props.store.active) {
            this.clear();
        }
    };

    public moveActive = (direction: "next" | "previous"): void => {
        const ids = this.selectableIds();
        if (!ids.length) return;
        const current = this.activeId ? ids.indexOf(this.activeId) : -1;
        const step = direction === "next" ? 1 : -1;
        const next =
            current === -1 ? (direction === "next" ? 0 : ids.length - 1) : (current + step + ids.length) % ids.length;
        this.activeId = ids[next];
        this.refresh();
    };

    public activate = (id: string): void => {
        const option = this.sections.flatMap((section) => section.options).find((candidate) => candidate.id === id);
        if (!option) return;

        if (option.kind === "recent") {
            this.chips = this.recentFor(option.id)?.filters ?? [];
            this.text = this.recentFor(option.id)?.text ?? "";
            this.activeId = null;
            this.runSearch();
        } else if (option.kind === "choice") {
            const filter = this.filterForOption(option);
            if (!filter) return;
            this.addChip(filter);
            this.text = this.withoutPending(this.text);
            this.activeId = null;
            this.runSearch();
        } else if (option.kind === "filter") {
            if (option.filter === "more") {
                this.moreOpen = true;
            } else {
                this.text = `${this.withoutPending(this.text)}${option.filter}:`;
            }
            this.activeId = null;
            this.refresh();
        }
    };

    public submit = (): void => {
        if (this.activeId) {
            this.activate(this.activeId);
            return;
        }
        this.runSearch();
    };

    // --- search ------------------------------------------------------------------------------------------------

    /** Turns the text and chips into one query and shows its results. */
    private runSearch(): void {
        const parsed = parseQuery(this.text, this.resolver);
        for (const filter of parsed.filters) this.addChip(filter);
        this.text = parsed.text;

        const query: SearchQuery = { text: this.text.trim(), filters: this.chips };
        this.open = false;
        this.moreOpen = false;
        if (isEmptyQuery(query)) {
            this.refresh();
            return;
        }
        this.recents = addRecentSearch(this.userId, query, this.props.storage);
        this.props.store.start(query, resolveScope(this.scopeInput(), query.filters));
        this.refresh();
    }

    private afterChipsChanged(): void {
        this.activeId = null;
        const query: SearchQuery = { text: this.text.trim(), filters: this.chips };
        if (this.props.store.active) {
            // Results are showing: keep them in step with the filters, or close them when nothing is left.
            if (isEmptyQuery(query)) this.props.store.close();
            else this.props.store.start(query, resolveScope(this.scopeInput(), query.filters));
        }
        this.refresh();
    }

    private addChip(filter: SearchFilter): void {
        if (SINGLE_VALUED.has(filter.key)) this.chips = this.chips.filter((chip) => chip.key !== filter.key);
        if (!this.chips.some((chip) => filterId(chip) === filterId(filter))) this.chips = [...this.chips, filter];
    }

    private recentFor(id: string): SearchQuery | undefined {
        return this.recents[Number(id.replace("recent:", ""))];
    }

    // --- events ------------------------------------------------------------------------------------------------

    private onAction = (payload: ActionPayload): void => {
        if (payload.action !== Action.FocusMessageSearch) return;
        this.focusRequest++;
        const initialText = (payload as FocusMessageSearchPayload).initialText;
        if (initialText) {
            // Other parts of the app ask for a ready-made search, such as the channel menu's `has:file` for Files.
            const parsed = parseQuery(initialText, this.resolver);
            this.chips = [];
            parsed.filters.forEach((filter) => this.addChip(filter));
            this.text = parsed.text;
            this.runSearch();
        } else {
            this.open = true;
            this.moreOpen = false;
            this.refresh();
        }
    };

    private onStoreUpdate = (): void => {
        const active = this.props.store.active;
        if (!active) {
            // The results were closed from their own × button.
            this.chips = [];
            this.text = "";
            this.activeId = null;
        }
        this.refresh();
    };

    // --- suggestions -------------------------------------------------------------------------------------------

    private members(): { id: string; name: string }[] {
        const { client, room } = this.props;
        const { space } = this.scopeInput();
        const rooms = [room, space ? client.getRoom(space.roomId) : null];
        const byId = new Map<string, string>();
        for (const source of rooms) {
            for (const member of source?.getJoinedMembers() ?? [])
                byId.set(member.userId, member.name || member.userId);
        }
        return [...byId].map(([id, name]) => ({ id, name }));
    }

    private channels(): { id: string; name: string }[] {
        const { client } = this.props;
        return resolveScope(this.scopeInput(), [])
            .roomIds.map((id) => client.getRoom(id))
            .filter((room): room is Room => !!room && !room.isSpaceRoom())
            .map((room) => ({ id: room.roomId, name: room.name }));
    }

    private resolver: FilterValueResolver = (key, raw) => {
        const wanted = raw.replace(/^#/, "").toLowerCase();
        const pool = key === "in" ? this.channels() : key === "from" || key === "mentions" ? this.members() : [];
        const found = pool.find((item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
        return found ? { value: found.id, label: found.name } : null;
    };

    private withoutPending(text: string): string {
        const pending = pendingFilter(text);
        return pending ? text.slice(0, pending.start) : text;
    }

    private filterForOption(option: Extract<DesktopSearchOption, { kind: "choice" }>): SearchFilter | null {
        const separator = option.id.indexOf(":");
        const key = option.id.slice(0, separator) as SearchFilterKey;
        const value = option.id.slice(separator + 1);
        return value ? { key, value, label: option.title && option.title !== value ? option.title : undefined } : null;
    }

    private valueOptions(key: SearchFilterKey, partial: string): DesktopSearchSection | null {
        const needle = partial.toLowerCase();
        const taken = new Set(this.chips.map(filterId));
        const pick = (
            filter: SearchFilterKey,
            value: string,
            extra: Partial<Extract<DesktopSearchOption, { kind: "choice" }>>,
        ): DesktopSearchOption => ({
            id: `${filter}:${value}`,
            kind: "choice",
            filter,
            ...extra,
        });

        switch (key) {
            case "from":
            case "mentions": {
                const options = this.members()
                    .filter((member) => !taken.has(`${key}:${member.id}`))
                    .filter(
                        (member) =>
                            member.name.toLowerCase().includes(needle) || member.id.toLowerCase().includes(needle),
                    )
                    .slice(0, MAX_SUGGESTIONS)
                    .map((member) => pick(key, member.id, { title: member.name, subtitle: member.id }));
                return { id: "members", options };
            }
            case "in": {
                const options = this.channels()
                    .filter((channel) => !taken.has(`in:${channel.id}`) && channel.name.toLowerCase().includes(needle))
                    .slice(0, MAX_SUGGESTIONS)
                    .map((channel) => pick("in", channel.id, { title: channel.name }));
                return { id: "channels", options };
            }
            case "has": {
                const options = HAS_VALUES.filter(
                    (value) => value.startsWith(needle) && !taken.has(`has:${value}`),
                ).map((value) => pick("has", value, { titleKey: `has_${value}` as DesktopSearchValueKey }));
                return { id: "has", options };
            }
            case "pinned":
            case "bot": {
                const options = (["true", "false"] as const)
                    .filter((value) => value.startsWith(needle))
                    .map((value) => pick(key, value, { titleKey: `${key}_${value}` as DesktopSearchValueKey }));
                return { id: "values", options };
            }
            case "before":
            case "after":
            case "during": {
                const now = new Date();
                const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
                const options: DesktopSearchOption[] = [];
                if (parseIsoDate(partial) !== null) {
                    options.push(pick(key, partial, { title: partial }));
                } else {
                    options.push(pick(key, isoDay(now), { titleKey: "today", subtitle: isoDay(now) }));
                    options.push(pick(key, isoDay(yesterday), { titleKey: "yesterday", subtitle: isoDay(yesterday) }));
                    options.push({ id: `hint:${key}`, kind: "hint", filter: key });
                }
                return { id: "dates", options };
            }
        }
    }

    private computeSections(): DesktopSearchSection[] {
        const pending = pendingFilter(this.text);
        if (pending) {
            const section = this.valueOptions(pending.key, pending.partial);
            return section ? [section] : [];
        }

        const filters = (this.moreOpen ? MORE_FILTERS : BASE_FILTERS).map((filter): DesktopSearchOption => ({
            id: `filter:${filter}`,
            kind: "filter",
            filter,
        }));
        const sections: DesktopSearchSection[] = [{ id: this.moreOpen ? "more" : "filters", options: filters }];
        if (!this.moreOpen && this.recents.length) {
            sections.push({
                id: "recent",
                clearable: true,
                options: this.recents.slice(0, MAX_RECENTS_SHOWN).map((recent, index): DesktopSearchOption => ({
                    id: `recent:${index}`,
                    kind: "recent",
                    text: recent.text,
                    chips: recent.filters.map((filter) => ({
                        id: filterId(filter),
                        filter: filter.key,
                        value: filter.label ?? filter.value,
                    })),
                })),
            });
        }
        return sections;
    }

    private selectableIds(): string[] {
        return this.sections
            .flatMap((section) => section.options)
            .filter((option) => option.kind === "filter" || option.kind === "choice" || option.kind === "recent")
            .map((option) => option.id);
    }

    private refresh = (): void => {
        this.sections = this.computeSections();
        if (this.activeId && !this.selectableIds().includes(this.activeId)) this.activeId = null;
        this.snapshot.merge({
            scopeName: this.scopeName(),
            text: this.text,
            chips: this.chips.map((chip) => ({
                id: filterId(chip),
                filter: chip.key,
                value: chip.label ?? chip.value,
            })),
            open: this.open,
            sections: this.sections,
            activeId: this.activeId,
            focusRequest: this.focusRequest,
        });
    };
}
