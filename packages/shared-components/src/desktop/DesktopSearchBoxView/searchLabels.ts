/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    type DesktopSearchFilterKey,
    type DesktopSearchSectionId,
    type DesktopSearchValueKey,
} from "./DesktopSearchBoxView";

/** The translate function of the i18n context. */
type Translate = (key: string) => string;

// The i18n tooling only keeps strings it can see written out, so each key is spelled in full here.

export function filterTitle(_t: Translate, filter: DesktopSearchFilterKey): string {
    switch (filter) {
        case "from":
            return _t("desktop|search|filter|from|title");
        case "in":
            return _t("desktop|search|filter|in|title");
        case "has":
            return _t("desktop|search|filter|has|title");
        case "mentions":
            return _t("desktop|search|filter|mentions|title");
        case "more":
            return _t("desktop|search|filter|more|title");
        case "before":
            return _t("desktop|search|filter|before|title");
        case "after":
            return _t("desktop|search|filter|after|title");
        case "during":
            return _t("desktop|search|filter|during|title");
        case "pinned":
            return _t("desktop|search|filter|pinned|title");
        case "bot":
            return _t("desktop|search|filter|bot|title");
    }
}

export function filterHint(_t: Translate, filter: DesktopSearchFilterKey): string {
    switch (filter) {
        case "from":
            return _t("desktop|search|filter|from|hint");
        case "in":
            return _t("desktop|search|filter|in|hint");
        case "has":
            return _t("desktop|search|filter|has|hint");
        case "mentions":
            return _t("desktop|search|filter|mentions|hint");
        case "more":
            return _t("desktop|search|filter|more|hint");
        case "before":
            return _t("desktop|search|filter|before|hint");
        case "after":
            return _t("desktop|search|filter|after|hint");
        case "during":
            return _t("desktop|search|filter|during|hint");
        case "pinned":
            return _t("desktop|search|filter|pinned|hint");
        case "bot":
            return _t("desktop|search|filter|bot|hint");
    }
}

export function valueLabel(_t: Translate, key: DesktopSearchValueKey): string {
    switch (key) {
        case "has_link":
            return _t("desktop|search|value|has_link");
        case "has_file":
            return _t("desktop|search|value|has_file");
        case "has_image":
            return _t("desktop|search|value|has_image");
        case "has_video":
            return _t("desktop|search|value|has_video");
        case "has_sound":
            return _t("desktop|search|value|has_sound");
        case "pinned_true":
            return _t("desktop|search|value|pinned_true");
        case "pinned_false":
            return _t("desktop|search|value|pinned_false");
        case "bot_true":
            return _t("desktop|search|value|bot_true");
        case "bot_false":
            return _t("desktop|search|value|bot_false");
        case "today":
            return _t("desktop|search|value|today");
        case "yesterday":
            return _t("desktop|search|value|yesterday");
    }
}

export function sectionHeading(_t: Translate, id: DesktopSearchSectionId): string {
    switch (id) {
        case "filters":
            return _t("desktop|search|section|filters");
        case "recent":
            return _t("desktop|search|section|recent");
        case "members":
            return _t("desktop|search|section|members");
        case "channels":
            return _t("desktop|search|section|channels");
        case "has":
            return _t("desktop|search|section|has");
        case "dates":
            return _t("desktop|search|section|dates");
        case "more":
            return _t("desktop|search|section|more");
        case "values":
            return _t("desktop|search|section|values");
    }
}
