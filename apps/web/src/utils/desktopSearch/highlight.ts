/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** A piece of text and whether it matched. */
export interface HighlightSegment {
    text: string;
    match: boolean;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words worth highlighting from what the user typed, without quotes and one-letter noise. */
export function termsFromText(text: string): string[] {
    return text
        .replace(/"/g, " ")
        .split(/\s+/)
        .filter((word) => word.length >= 2);
}

/** Splits `body` into plain and matching segments. Matching ignores case and keeps the original text. */
export function highlightSegments(body: string, terms: string[]): HighlightSegment[] {
    const usable = [...new Set(terms.filter((term) => term.length > 0))].sort((a, b) => b.length - a.length);
    if (!body || usable.length === 0) return [{ text: body, match: false }];

    const pattern = new RegExp(`(${usable.map(escapeRegExp).join("|")})`, "gi");
    const segments: HighlightSegment[] = [];
    let last = 0;
    for (const match of body.matchAll(pattern)) {
        if (match.index > last) segments.push({ text: body.slice(last, match.index), match: false });
        segments.push({ text: match[0], match: true });
        last = match.index + match[0].length;
    }
    if (last < body.length) segments.push({ text: body.slice(last), match: false });
    return segments;
}
